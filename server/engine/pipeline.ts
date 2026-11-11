import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentDef, Ev, Input, Project, Runner, Scheme, StageDef } from './types.ts'

export type Settings = { humanReview: boolean; simulation: boolean }
const DEFAULTS: Settings = { humanReview: true, simulation: true }

type StepRow = { stage: string; agent: string; version: number; status: 'done' | 'rejected'; feedback: string | null }
type StageRow = { stage: string; status: 'working' | 'audited' | 'escalated' | 'approved'; attempts: number }

/** Devuelve el problema del traspaso, o null si cumple el contrato. */
export function checkContract(outDir: string, agent: AgentDef): string | null {
  let handoff: any
  try {
    handoff = JSON.parse(readFileSync(join(outDir, 'handoff.json'), 'utf8'))
  } catch {
    return 'handoff.json falta o no es JSON válido'
  }
  if (typeof handoff?.summary !== 'string' || !handoff.summary.trim()) return 'handoff.json no tiene resumen'
  if (!Array.isArray(handoff.files) || handoff.files.some((f: unknown) => typeof f !== 'string')) return 'handoff.json no lista archivos'
  const base = resolve(outDir) + sep
  for (const file of new Set<string>([...agent.deliverables, ...handoff.files])) {
    const path = resolve(outDir, file)
    if (!path.startsWith(base)) return `archivo fuera de la carpeta del agente: ${file}`
    if (!existsSync(path) || statSync(path).size === 0) return `falta el entregable ${file}`
  }
  return null
}

export function createEngine(opts: {
  db: DatabaseSync
  workspace: string
  schemes: Record<string, Scheme>
  runner: Runner
  maxAuditRetries?: number
  maxContractRetries?: number
}) {
  const { db, workspace, schemes, runner } = opts
  const maxAuditRetries = opts.maxAuditRetries ?? 2
  const maxContractRetries = opts.maxContractRetries ?? 2
  const bus = new EventEmitter().setMaxListeners(0)
  const active = new Map<string, Promise<void>>()

  const one = (sql: string, ...p: any[]) => db.prepare(sql).get(...p) as any
  const all = (sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[]
  const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p)

  function emit(projectId: string, type: string, data: object = {}) {
    const ts = new Date().toISOString()
    const { lastInsertRowid } = run('INSERT INTO events (project_id, ts, type, data) VALUES (?,?,?,?)', projectId, ts, type, JSON.stringify(data))
    bus.emit('event', { id: Number(lastInsertRowid), projectId, ts, type, data } satisfies Ev)
  }

  function eventsAfter(projectId: string, after = 0): Ev[] {
    return all('SELECT * FROM events WHERE project_id = ? AND id > ? ORDER BY id', projectId, after).map((r) => ({
      id: r.id, projectId: r.project_id, ts: r.ts, type: r.type, data: JSON.parse(r.data),
    }))
  }

  function subscribe(fn: (ev: Ev) => void) {
    bus.on('event', fn)
    return () => void bus.off('event', fn)
  }

  function getSettings(): Settings {
    const stored = Object.fromEntries(all('SELECT key, value FROM settings').map((r) => [r.key, JSON.parse(r.value)]))
    return { ...DEFAULTS, ...stored }
  }

  function setSettings(patch: Partial<Settings>) {
    for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      if (typeof patch[key] === 'boolean') run('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(patch[key]))
    }
    return getSettings()
  }

  function project(id: string): Project {
    const p = one('SELECT * FROM projects WHERE id = ?', id)
    if (!p) throw new Error(`Proyecto no encontrado: ${id}`)
    return p
  }

  function setStatus(id: string, status: Project['status'], reason: string | null = null) {
    run('UPDATE projects SET status = ?, reason = ? WHERE id = ?', status, reason, id)
    emit(id, 'project.status', { status, reason })
  }

  function stageRow(id: string, stage: StageDef): StageRow {
    const row = one('SELECT * FROM stages WHERE project_id = ? AND stage = ?', id, stage.id)
    if (row) return row
    run('INSERT INTO stages (project_id, stage) VALUES (?,?)', id, stage.id)
    emit(id, 'stage.started', { stage: stage.id })
    return { stage: stage.id, status: 'working', attempts: 0 }
  }

  const setStage = (id: string, stage: string, status: StageRow['status'], attempts?: number) =>
    run('UPDATE stages SET status = ?, attempts = COALESCE(?, attempts) WHERE project_id = ? AND stage = ?', status, attempts ?? null, id, stage)

  const latestStep = (id: string, stage: string, agent: string): StepRow | undefined =>
    one('SELECT * FROM steps WHERE project_id = ? AND stage = ? AND agent = ? ORDER BY version DESC LIMIT 1', id, stage, agent)

  const stepDir = (id: string, stage: string, agent: string, version: number) => join(workspace, id, stage, agent, `v${version}`)

  /** Entregables vigentes de las etapas anteriores y de los agentes previos de esta etapa. */
  function inputsFor(id: string, scheme: Scheme, stage: StageDef, before?: AgentDef): Input[] {
    const inputs: Input[] = []
    for (const s of scheme.stages) {
      for (const a of s.agents) {
        if (s === stage && a === before) return inputs
        const step = latestStep(id, s.id, a.id)
        if (step?.status === 'done') inputs.push({ stage: s.id, agent: a.id, dir: stepDir(id, s.id, a.id, step.version) })
      }
      if (s === stage) return inputs
    }
    return inputs
  }

  function addCost(id: string, stage: string, agent: string, usd: number) {
    if (!(usd > 0)) return
    run('UPDATE projects SET spent = spent + ? WHERE id = ?', usd, id)
    emit(id, 'cost', { stage, agent, usd, spent: project(id).spent })
  }

  async function runStep(p: Project, scheme: Scheme, stage: StageDef, agent: AgentDef) {
    const prev = latestStep(p.id, stage.id, agent.id)
    const version = (prev?.version ?? 0) + 1
    const outDir = stepDir(p.id, stage.id, agent.id, version)
    const next = stage.agents[stage.agents.indexOf(agent) + 1]
    const to = next?.id ?? stage.auditor.id
    for (let attempt = 0; ; attempt++) {
      rmSync(outDir, { recursive: true, force: true })
      mkdirSync(outDir, { recursive: true })
      emit(p.id, 'agent.started', { stage: stage.id, agent: agent.id, version, feedback: prev?.feedback ?? null })
      const { costUsd } = await runner.runAgent({
        project: p, stage, agent, version, outDir, to,
        inputs: inputsFor(p.id, scheme, stage, agent),
        feedback: prev?.feedback ?? null,
        say: (text) => emit(p.id, 'agent.message', { stage: stage.id, agent: agent.id, text }),
      })
      addCost(p.id, stage.id, agent.id, costUsd)
      const problem = checkContract(outDir, agent)
      if (!problem) break
      emit(p.id, 'contract.failed', { stage: stage.id, agent: agent.id, version, problem })
      if (attempt >= maxContractRetries) throw new Error(`${agent.name} no cumplió el contrato de entrega: ${problem}`)
    }
    run('INSERT INTO steps (project_id, stage, agent, version, status) VALUES (?,?,?,?,?)', p.id, stage.id, agent.id, version, 'done')
    emit(p.id, 'agent.done', { stage: stage.id, agent: agent.id, version, to, files: agent.deliverables })
  }

  function sendBack(id: string, stage: StageDef, agents: string[], feedback: string) {
    for (const agent of agents) {
      const step = latestStep(id, stage.id, agent)
      if (step) run('UPDATE steps SET status = ?, feedback = ? WHERE project_id = ? AND stage = ? AND agent = ? AND version = ?', 'rejected', feedback, id, stage.id, agent, step.version)
    }
  }

  async function audit(p: Project, scheme: Scheme, stage: StageDef, row: StageRow) {
    const auditor = stage.auditor.id
    emit(p.id, 'audit.started', { stage: stage.id, auditor })
    const verdict = await runner.runAuditor({
      project: p, stage,
      deliverables: inputsFor(p.id, scheme, stage).filter((i) => i.stage === stage.id),
      say: (text) => emit(p.id, 'agent.message', { stage: stage.id, agent: auditor, text }),
    })
    addCost(p.id, stage.id, auditor, verdict.costUsd)
    // Un rechazo sin agente válido señalado devuelve el trabajo a toda la etapa.
    const known = verdict.issues.filter((i) => stage.agents.some((a) => a.id === i.agent))
    const issues = verdict.approved ? [] : known.length ? known : stage.agents.map((a) => ({ agent: a.id, problem: verdict.issues[0]?.problem ?? 'El auditor rechazó la etapa sin detalle' }))
    emit(p.id, 'audit.verdict', { stage: stage.id, auditor, approved: verdict.approved, issues, attempt: row.attempts + 1 })
    if (verdict.approved) return setStage(p.id, stage.id, 'audited')
    if (row.attempts >= maxAuditRetries) return setStage(p.id, stage.id, 'escalated')
    for (const issue of issues) sendBack(p.id, stage, [issue.agent], issue.problem)
    setStage(p.id, stage.id, 'working', row.attempts + 1)
  }

  /** Avanza desde el estado guardado hasta terminar o necesitar a una persona. */
  async function loop(id: string) {
    const scheme = schemes[project(id).scheme]
    for (const stage of scheme.stages) {
      while (true) {
        const p = project(id)
        if (p.status !== 'running') return
        const row = stageRow(id, stage)
        if (row.status === 'approved') break
        if (row.status === 'working') {
          // ponytail: agentes en secuencia; paralelizar los independientes cuando el tiempo de generación real lo pida.
          const pending = stage.agents.find((a) => latestStep(id, stage.id, a.id)?.status !== 'done')
          if (!pending) await audit(p, scheme, stage, row)
          else if (p.spent >= p.budget_cap) return setStatus(id, 'paused', 'budget')
          else await runStep(p, scheme, stage, pending)
        } else if (row.status === 'audited' && !getSettings().humanReview) {
          setStage(id, stage.id, 'approved')
          emit(id, 'stage.approved', { stage: stage.id, by: 'auditor' })
        } else {
          return setStatus(id, 'waiting_human', row.status === 'escalated' ? 'escalated' : 'gate')
        }
      }
    }
    setStatus(id, 'done')
  }

  function advance(id: string): Promise<void> {
    let job = active.get(id)
    if (!job) {
      job = loop(id)
        .catch((err) => setStatus(id, 'failed', err instanceof Error ? err.message : String(err)))
        .finally(() => active.delete(id))
      active.set(id, job)
    }
    return job
  }

  function currentStage(id: string): StageDef | undefined {
    const done = new Set(all("SELECT stage FROM stages WHERE project_id = ? AND status = 'approved'", id).map((r) => r.stage))
    return schemes[project(id).scheme].stages.find((s) => !done.has(s.id))
  }

  function createProject(input: { name: string; brief: string; budgetCap: number; scheme?: string }) {
    const scheme = input.scheme ?? 'commercial'
    if (!schemes[scheme]) throw new Error(`Esquema desconocido: ${scheme}`)
    const id = `p_${randomUUID().slice(0, 8)}`
    run('INSERT INTO projects (id, name, brief, scheme, status, budget_cap, created_at) VALUES (?,?,?,?,?,?,?)', id, input.name, input.brief, scheme, 'running', input.budgetCap, new Date().toISOString())
    emit(id, 'project.status', { status: 'running', reason: null })
    void advance(id)
    return project(id)
  }

  /** Decisión de una persona en un gate o tras una escalada del auditor. */
  function decide(id: string, d: { approve: boolean; comment?: string; agents?: string[] }) {
    const p = project(id)
    const stage = currentStage(id)
    if (p.status !== 'waiting_human' || !stage) throw new Error('El proyecto no está esperando una decisión')
    if (!d.approve && !d.comment?.trim()) throw new Error('Un rechazo necesita un comentario')
    emit(id, 'gate.decided', { stage: stage.id, approve: d.approve, comment: d.comment ?? null })
    if (d.approve) {
      setStage(id, stage.id, 'approved')
      emit(id, 'stage.approved', { stage: stage.id, by: 'human' })
    } else {
      const agents = d.agents?.length ? d.agents : stage.agents.map((a) => a.id)
      sendBack(id, stage, agents, d.comment!)
      setStage(id, stage.id, 'working', 0)
    }
    setStatus(id, 'running')
    return advance(id)
  }

  function pause(id: string) {
    if (project(id).status !== 'running') throw new Error('Solo se puede pausar un proyecto en marcha')
    setStatus(id, 'paused', 'manual')
  }

  function resume(id: string, budgetCap?: number) {
    const p = project(id)
    if (p.status !== 'paused' && p.status !== 'failed') throw new Error('El proyecto no está pausado')
    if (budgetCap !== undefined) run('UPDATE projects SET budget_cap = ? WHERE id = ?', budgetCap, id)
    setStatus(id, 'running')
    return advance(id)
  }

  function cancel(id: string) {
    const p = project(id)
    if (p.status === 'done' || p.status === 'cancelled') throw new Error('El proyecto ya terminó')
    setStatus(id, 'cancelled')
  }

  /** Relanza un agente de la etapa actual con una nota. El proyecto debe estar pausado. */
  async function rerun(id: string, agent: string, note: string) {
    const p = project(id)
    const stage = currentStage(id)
    if (p.status !== 'paused' || !stage?.agents.some((a) => a.id === agent)) throw new Error('Pausa el proyecto y elige un agente de la etapa actual')
    if (!note.trim()) throw new Error('Relanzar un agente necesita una nota')
    await active.get(id)
    sendBack(id, stage, [agent], note)
    setStage(id, stage.id, 'working')
    void resume(id)
  }

  /** Tras reiniciar el servidor: retoma los proyectos que estaban en marcha. */
  function resumeAll() {
    return Promise.all(all("SELECT id FROM projects WHERE status = 'running'").map((r) => advance(r.id)))
  }

  function getProject(id: string) {
    return {
      ...project(id),
      currentStage: currentStage(id)?.id ?? null,
      stages: all('SELECT stage, status, attempts FROM stages WHERE project_id = ?', id) as StageRow[],
      steps: all('SELECT stage, agent, version, status, feedback FROM steps WHERE project_id = ? ORDER BY rowid', id) as StepRow[],
    }
  }

  const listProjects = () => all('SELECT * FROM projects ORDER BY created_at DESC') as Project[]

  return { advance, resumeAll, createProject, getProject, listProjects, decide, pause, resume, cancel, rerun, getSettings, setSettings, subscribe, eventsAfter, workspace, schemes }
}

export type Engine = ReturnType<typeof createEngine>
