import { randomUUID } from 'node:crypto'
import { brandDir, type AgentDef, type Asset, type Brand, type Db, type Ev, type Files, type Input, type NewAsset, type Project, type Runner, type Scheme, type StageDef } from './types.ts'

export type Settings = { humanReview: boolean; simulation: boolean }
const DEFAULTS: Settings = { humanReview: true, simulation: true }

type StepRow = { stage: string; agent: string; version: number; status: 'done' | 'rejected'; feedback: string | null; model: string | null }
type StageRow = { stage: string; status: 'working' | 'audited' | 'escalated' | 'approved'; attempts: number }

/** Devuelve el problema del traspaso, o null si cumple el contrato. */
export async function checkContract(files: Files, dir: string, agent: AgentDef): Promise<string | null> {
  let handoff: any
  try {
    handoff = JSON.parse((await files.read(`${dir}/handoff.json`)) ?? '')
  } catch {
    return 'handoff.json falta o no es JSON válido'
  }
  if (typeof handoff?.summary !== 'string' || !handoff.summary.trim()) return 'handoff.json no tiene resumen'
  if (!Array.isArray(handoff.files) || handoff.files.some((f: unknown) => typeof f !== 'string')) return 'handoff.json no lista archivos'
  // Una sola lista de la carpeta: los entregables pueden ser videos y no conviene descargarlos para saber si existen.
  const present = new Set(await files.list(dir))
  for (const file of new Set<string>([...agent.deliverables, ...handoff.files])) {
    if (!/^[\w.-]+$/.test(file) || file.includes('..')) return `nombre de archivo no permitido: ${file}`
    if (!present.has(file)) return `falta el entregable ${file}`
  }
  return null
}

export function createEngine(opts: {
  db: Db
  files: Files
  schemes: Record<string, Scheme>
  runner: Runner
  maxAuditRetries?: number
  maxContractRetries?: number
}) {
  const { db, files, schemes, runner } = opts
  const maxAuditRetries = opts.maxAuditRetries ?? 2
  const maxContractRetries = opts.maxContractRetries ?? 2
  const active = new Map<string, Promise<void>>()
  /** Para cortar al agente en curso cuando una persona cancela el proyecto. */
  const aborts = new Map<string, AbortController>()
  const one = async (sql: string, ...p: unknown[]) => (await db(sql, ...p))[0]
  const now = () => new Date().toISOString()
  const kick = (id: string) => void advance(id)

  // Los eventos de un proyecto se insertan de uno en uno: así su número respeta el orden en que ocurrieron
  // y el navegador, que pide "los posteriores al último que vi", nunca se salta uno que llegó tarde.
  const queues = new Map<string, Promise<unknown>>()
  function emit(projectId: string, type: string, data: object = {}): Promise<void> {
    const ts = now()
    const next = (queues.get(projectId) ?? Promise.resolve()).catch(() => {}).then(() => db('INSERT INTO events (project_id, ts, type, data) VALUES (?,?,?,?)', projectId, ts, type, JSON.stringify(data)))
    queues.set(projectId, next)
    return next.then(() => {})
  }
  /** Lo que un agente dice en la oficina es accesorio: si no se puede guardar, el trabajo sigue. */
  const chatter = (projectId: string, stage: string, agent: string, text: string) => void emit(projectId, 'agent.message', { stage, agent, text }).catch(() => {})

  async function eventsAfter(projectId: string, after = 0): Promise<Ev[]> {
    const rows = await db('SELECT * FROM events WHERE project_id = ? AND id > ? ORDER BY id', projectId, after)
    return rows.map((r) => ({ id: Number(r.id), projectId: r.project_id, ts: r.ts, type: r.type, data: JSON.parse(r.data) }))
  }

  async function getSettings(): Promise<Settings> {
    const rows = await db('SELECT key, value FROM settings')
    return { ...DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)])) }
  }

  async function setSettings(patch: Partial<Settings>) {
    for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      if (typeof patch[key] === 'boolean') await db('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(patch[key]))
    }
    return getSettings()
  }

  async function project(id: string): Promise<Project> {
    const p = await one('SELECT * FROM projects WHERE id = ?', id)
    if (!p) throw new Error(`Proyecto no encontrado: ${id}`)
    return p
  }

  /** La marca con sus archivos reales: logo y fotos de producto que subió el cliente. */
  async function brandByName(name: string): Promise<Brand | null> {
    const row = await one('SELECT name, kit FROM brands WHERE name = ?', name)
    if (!row) return null
    const dir = brandDir(row.name)
    return { name: row.name, kit: row.kit, assets: (await files.list(dir)).map((f) => `${dir}/${f}`) }
  }
  const brandOf = (p: Project): Promise<Brand | null> => (p.brand ? brandByName(p.brand) : Promise.resolve(null))

  const recordAsset = async (id: string, a: NewAsset): Promise<void> =>
    void (await db('INSERT INTO assets (project_id, path, kind, tool, provider, model, prompt, seed, inputs, cost_usd, license, measurements, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, a.path, a.kind, a.tool, a.provider, a.model, a.prompt, a.seed, JSON.stringify(a.inputs), a.costUsd, a.license, a.measurements ? JSON.stringify(a.measurements) : null, now()))

  /** Procedencia de los archivos vigentes. Si un archivo se regeneró con el mismo nombre, vale el último registro. */
  async function listAssets(id: string): Promise<Asset[]> {
    const rows = await db('SELECT * FROM assets WHERE project_id = ? ORDER BY id', id)
    const byPath = new Map<string, Asset>()
    for (const r of rows) byPath.set(r.path, { path: r.path, kind: r.kind, tool: r.tool, provider: r.provider, model: r.model, prompt: r.prompt, seed: r.seed, inputs: JSON.parse(r.inputs), costUsd: Number(r.cost_usd), license: r.license, measurements: r.measurements ? JSON.parse(r.measurements) : null, createdAt: r.created_at })
    return [...byPath.values()]
  }

  async function setStatus(id: string, status: Project['status'], reason: string | null = null) {
    await db('UPDATE projects SET status = ?, reason = ? WHERE id = ?', status, reason, id)
    await emit(id, 'project.status', { status, reason })
  }

  async function stageRow(id: string, stage: StageDef): Promise<StageRow> {
    const row = await one('SELECT * FROM stages WHERE project_id = ? AND stage = ?', id, stage.id)
    if (row) return row
    await db("INSERT INTO stages (project_id, stage, status, attempts) VALUES (?,?,'working',0)", id, stage.id)
    await emit(id, 'stage.started', { stage: stage.id })
    return { stage: stage.id, status: 'working', attempts: 0 }
  }

  const setStage = (id: string, stage: string, status: StageRow['status'], attempts?: number) =>
    db('UPDATE stages SET status = ?, attempts = COALESCE(?, attempts) WHERE project_id = ? AND stage = ?', status, attempts ?? null, id, stage)

  /** La versión más reciente de cada agente, por clave `etapa/agente`. */
  async function latestSteps(id: string) {
    const rows: StepRow[] = await db('SELECT stage, agent, version, status, feedback, model FROM steps WHERE project_id = ? ORDER BY version', id)
    return new Map(rows.map((r) => [`${r.stage}/${r.agent}`, r]))
  }

  const stepDir = (id: string, stage: string, agent: string, version: number) => `${id}/${stage}/${agent}/v${version}`

  /** Entregables vigentes de las etapas anteriores y de los agentes previos de esta etapa. */
  function inputsFor(id: string, latest: Map<string, StepRow>, scheme: Scheme, stage: StageDef, before?: AgentDef): Input[] {
    const inputs: Input[] = []
    for (const s of scheme.stages) {
      for (const a of s.agents) {
        if (s === stage && a === before) return inputs
        const step = latest.get(`${s.id}/${a.id}`)
        if (step?.status === 'done') inputs.push({ stage: s.id, agent: a.id, dir: stepDir(id, s.id, a.id, step.version) })
      }
      if (s === stage) return inputs
    }
    return inputs
  }

  async function addCost(id: string, stage: string, agent: string, usd: number) {
    if (!(usd > 0)) return
    await db('UPDATE projects SET spent = spent + ? WHERE id = ?', usd, id)
    await emit(id, 'cost', { stage, agent, usd, spent: (await project(id)).spent })
  }

  const saveStep = (id: string, stage: string, agent: string, version: number, model: string) =>
    db('INSERT INTO steps (project_id, stage, agent, version, status, model, done_at) VALUES (?,?,?,?,?,?,?)', id, stage, agent, version, 'done', model, now())

  /**
   * Deja lista la carpeta de una versión nueva. Si hay una versión anterior, parte de una copia de sus archivos:
   * así el agente rehace solo lo que le devolvieron (un plano, una línea de voz) y no paga otra vez por todo.
   */
  async function prepareDir(id: string, stage: string, agent: string, version: number, dir: string) {
    // Si la carpeta ya tiene archivos es que un intento anterior se interrumpió (caída, error, tiempo agotado).
    // Lo que alcanzó a generar ya se pagó: se conserva y el agente lo retoma.
    if (version === 1 || (await files.list(dir)).length) return
    const prev = stepDir(id, stage, agent, version - 1)
    const names = (await files.list(prev)).filter((f) => f !== 'handoff.json')
    await Promise.all(names.map((f) => files.copy(`${prev}/${f}`, `${dir}/${f}`)))
    await copyAssets(id, prev, dir, names)
  }

  /** Los archivos copiados conservan su procedencia, con la ruta nueva. */
  async function copyAssets(id: string, from: string, to: string, names: string[]) {
    const rel = (d: string) => d.slice(id.length + 1)
    const known = new Map((await listAssets(id)).map((a) => [a.path, a]))
    for (const f of names) {
      const a = known.get(`${rel(from)}/${f}`)
      if (a) await recordAsset(id, { ...a, path: `${rel(to)}/${f}`, costUsd: 0 })
    }
  }

  async function runStep(p: Project, scheme: Scheme, stage: StageDef, agent: AgentDef, latest: Map<string, StepRow>) {
    const prev = latest.get(`${stage.id}/${agent.id}`)
    const version = (prev?.version ?? 0) + 1
    const dir = stepDir(p.id, stage.id, agent.id, version)
    const next = stage.agents[stage.agents.indexOf(agent) + 1]
    const to = next?.id ?? stage.auditor.id
    const brand = await brandOf(p)
    let model = ''
    let feedback = prev?.feedback ?? null
    for (let attempt = 0; ; attempt++) {
      await Promise.all([attempt === 0 ? prepareDir(p.id, stage.id, agent.id, version, dir) : null, emit(p.id, 'agent.started', { stage: stage.id, agent: agent.id, version, feedback })])
      const result = await runner.runAgent({
        // El gasto se relee en cada intento: el anterior pudo consumir casi todo el tope.
        project: attempt === 0 ? p : await project(p.id), stage, agent, version, dir, to, files, brand,
        inputs: inputsFor(p.id, latest, scheme, stage, agent),
        feedback,
        say: (text) => chatter(p.id, stage.id, agent.id, text),
        spend: (usd) => addCost(p.id, stage.id, agent.id, usd),
        record: (asset) => recordAsset(p.id, asset),
        assets: () => listAssets(p.id),
        signal: aborts.get(p.id)!.signal,
      })
      model = result.model
      await addCost(p.id, stage.id, agent.id, result.costUsd)
      const problem = await checkContract(files, dir, agent)
      if (!problem) break
      await emit(p.id, 'contract.failed', { stage: stage.id, agent: agent.id, version, problem })
      if (attempt >= maxContractRetries) throw new Error(`${agent.name} no cumplió el contrato de entrega: ${problem}`)
      // El reintento conserva la carpeta y le dice al agente qué faltó, para que no rehaga (ni pague) todo.
      feedback = `${prev?.feedback ? `${prev.feedback}\n` : ''}Tu entrega quedó incompleta: ${problem}. Completa solo lo que falta.`
    }
    await saveStep(p.id, stage.id, agent.id, version, model)
    // La lista real de archivos: los entregables fijos más lo que el agente generó con herramientas.
    const produced: string[] = JSON.parse((await files.read(`${dir}/handoff.json`))!).files
    await emit(p.id, 'agent.done', { stage: stage.id, agent: agent.id, version, to, files: [...new Set([...agent.deliverables, ...produced])] })
  }

  async function sendBack(id: string, stage: StageDef, agents: string[], feedback: string) {
    const latest = await latestSteps(id)
    for (const agent of agents) {
      const step = latest.get(`${stage.id}/${agent}`)
      if (step) await db('UPDATE steps SET status = ?, feedback = ? WHERE project_id = ? AND stage = ? AND agent = ? AND version = ?', 'rejected', feedback, id, stage.id, agent, step.version)
    }
  }

  async function audit(p: Project, scheme: Scheme, stage: StageDef, row: StageRow, latest: Map<string, StepRow>) {
    const auditor = stage.auditor.id
    await emit(p.id, 'audit.started', { stage: stage.id, auditor })
    const verdict = await runner.runAuditor({
      project: p, stage, files, brand: await brandOf(p),
      deliverables: inputsFor(p.id, latest, scheme, stage).filter((i) => i.stage === stage.id),
      say: (text) => chatter(p.id, stage.id, auditor, text),
      assets: () => listAssets(p.id),
      spend: (usd) => addCost(p.id, stage.id, auditor, usd),
      signal: aborts.get(p.id)!.signal,
    })
    await addCost(p.id, stage.id, auditor, verdict.costUsd)
    // Un rechazo sin agente válido señalado devuelve el trabajo a toda la etapa.
    const known = verdict.issues.filter((i) => stage.agents.some((a) => a.id === i.agent))
    const issues = verdict.approved ? [] : known.length ? known : stage.agents.map((a) => ({ agent: a.id, problem: verdict.issues[0]?.problem ?? 'El auditor rechazó la etapa sin detalle' }))
    await emit(p.id, 'audit.verdict', { stage: stage.id, auditor, approved: verdict.approved, issues, attempt: row.attempts + 1 })
    if (verdict.approved) return setStage(p.id, stage.id, 'audited')
    if (row.attempts >= maxAuditRetries) return setStage(p.id, stage.id, 'escalated')
    // Varios problemas para un mismo agente llegan juntos: guardarlos uno a uno dejaría solo el último.
    const byAgent = Map.groupBy(issues, (i) => i.agent)
    for (const [agent, list] of byAgent) await sendBack(p.id, stage, [agent], list.map((i) => i.problem).join('\n'))
    await setStage(p.id, stage.id, 'working', row.attempts + 1)
  }

  /** Avanza desde el estado guardado hasta terminar o necesitar a una persona. */
  async function loop(id: string) {
    const scheme = schemes[(await project(id)).scheme]
    // Las etapas ya aprobadas se saltan con una sola consulta: cada ida a la base cuesta una vuelta de red.
    const approved = new Set((await db("SELECT stage FROM stages WHERE project_id = ? AND status = 'approved'", id)).map((r) => r.stage))
    for (const stage of scheme.stages) {
      if (approved.has(stage.id)) continue
      while (true) {
        const p = await project(id)
        if (p.status !== 'running') return
        const row = await stageRow(id, stage)
        if (row.status === 'approved') break
        if (row.status === 'working') {
          // ponytail: agentes en secuencia; paralelizar exige declarar dependencias entre agentes en el esquema.
          const latest = await latestSteps(id)
          const pending = stage.agents.find((a) => latest.get(`${stage.id}/${a.id}`)?.status !== 'done')
          if (pending && p.spent >= p.budget_cap) return setStatus(id, 'paused', 'budget')
          if (pending) await runStep(p, scheme, stage, pending, latest)
          else await audit(p, scheme, stage, row, latest)
        } else if (row.status === 'audited' && !(await getSettings()).humanReview) {
          await setStage(id, stage.id, 'approved')
          await emit(id, 'stage.approved', { stage: stage.id, by: 'auditor' })
        } else {
          return setStatus(id, 'waiting_human', row.status === 'escalated' ? 'escalated' : 'gate')
        }
      }
    }
    // Pudo cancelarse o pausarse mientras se cerraba la última etapa.
    if ((await project(id)).status === 'running') await setStatus(id, 'done')
  }

  /** Un solo recorrido por proyecto a la vez dentro de este proceso. */
  function advance(id: string): Promise<void> {
    let job = active.get(id)
    if (!job) {
      aborts.set(id, new AbortController())
      let crashed = false
      job = loop(id)
        .catch(async (err) => {
          crashed = true
          // Solo un proyecto en marcha pasa a detenido: si la persona lo canceló o pausó, esa decisión se respeta.
          const reason = err instanceof Error ? err.message : String(err)
          const changed = await db("UPDATE projects SET status = 'failed', reason = ? WHERE id = ? AND status = 'running' RETURNING id", reason, id)
          if (changed.length) await emit(id, 'project.status', { status: 'failed', reason })
        })
        .catch((err) => console.error(`No se pudo registrar el fallo del proyecto ${id}:`, err))
        .finally(async () => {
          active.delete(id)
          aborts.delete(id)
          // Una reanudación que llegó justo cuando este recorrido terminaba no encontró sitio: se atiende ahora.
          // Tras un fallo no se reintenta solo: si ni siquiera se pudo anotar, insistir sería un bucle sin fin.
          if (!crashed && (await one('SELECT status FROM projects WHERE id = ?', id).catch(() => null))?.status === 'running') kick(id)
        })
      active.set(id, job)
    }
    return job
  }

  async function currentStage(id: string): Promise<StageDef | undefined> {
    const done = new Set((await db("SELECT stage FROM stages WHERE project_id = ? AND status = 'approved'", id)).map((r) => r.stage))
    return schemes[(await project(id)).scheme].stages.find((s) => !done.has(s.id))
  }

  const listBrands = (): Promise<{ name: string; kit: string }[]> => db('SELECT name, kit FROM brands ORDER BY name')

  /** Guarda un archivo real del cliente en la biblioteca de su marca. Crea la marca si no existía. */
  async function addBrandAsset(name: string, filename: string, bytes: Uint8Array, contentType: string) {
    await db("INSERT INTO brands (name, kit) VALUES (?, '') ON CONFLICT(name) DO NOTHING", name)
    await files.writeBytes(`${brandDir(name)}/${filename}`, bytes, contentType)
    return brandByName(name)
  }

  async function createProject(input: { name: string; brief: string; budgetCap: number; scheme?: string; brand?: { name: string; kit: string } }) {
    const scheme = input.scheme ?? 'commercial'
    if (!schemes[scheme]) throw new Error(`Esquema desconocido: ${scheme}`)
    // La biblioteca de marca se guarda por cliente y se reutiliza en sus siguientes proyectos.
    if (input.brand) await db('INSERT INTO brands (name, kit) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET kit = excluded.kit', input.brand.name, input.brand.kit)
    const id = `p_${randomUUID().slice(0, 8)}`
    await db('INSERT INTO projects (id, name, brief, scheme, brand, status, budget_cap, created_at) VALUES (?,?,?,?,?,?,?,?)', id, input.name, input.brief, scheme, input.brand?.name ?? null, 'running', input.budgetCap, now())
    await emit(id, 'project.status', { status: 'running', reason: null })
    kick(id)
    return project(id)
  }

  /** Decisión de una persona en un gate o tras una escalada del auditor. */
  async function decide(id: string, d: { approve: boolean; comment?: string; agents?: string[] }) {
    const [p, stage] = await Promise.all([project(id), currentStage(id)])
    if (p.status !== 'waiting_human' || !stage) throw new Error('El proyecto no está esperando una decisión')
    if (!d.approve && !d.comment?.trim()) throw new Error('Un rechazo necesita un comentario')
    await emit(id, 'gate.decided', { stage: stage.id, approve: d.approve, comment: d.comment ?? null })
    if (d.approve) {
      await setStage(id, stage.id, 'approved')
      await emit(id, 'stage.approved', { stage: stage.id, by: 'human' })
    } else {
      const all = stage.agents.map((a) => a.id)
      const chosen = (Array.isArray(d.agents) ? d.agents : []).filter((a) => all.includes(a))
      await sendBack(id, stage, chosen.length ? chosen : all, d.comment!)
      await setStage(id, stage.id, 'working', 0)
    }
    await setStatus(id, 'running')
    kick(id)
  }

  async function pause(id: string) {
    if ((await project(id)).status !== 'running') throw new Error('Solo se puede pausar un proyecto en marcha')
    await setStatus(id, 'paused', 'manual')
  }

  async function resume(id: string, budgetCap?: number) {
    const p = await project(id)
    if (p.status !== 'paused' && p.status !== 'failed') throw new Error('El proyecto no está pausado')
    if (budgetCap !== undefined && budgetCap <= p.spent) throw new Error(`El tope nuevo debe ser mayor que lo ya gastado ($${p.spent.toFixed(2)})`)
    if (budgetCap !== undefined) await db('UPDATE projects SET budget_cap = ? WHERE id = ?', budgetCap, id)
    await setStatus(id, 'running')
    kick(id)
  }

  async function cancel(id: string) {
    const p = await project(id)
    if (p.status === 'done' || p.status === 'cancelled') throw new Error('El proyecto ya terminó')
    await setStatus(id, 'cancelled')
    // Cancelar corta al agente en curso para que deje de gastar. Pausar no: deja que termine lo que está haciendo.
    aborts.get(id)?.abort(new Error('El proyecto se canceló'))
  }

  /** Comprueba que se puede intervenir a un agente de la etapa actual y que ningún paso sigue corriendo. */
  async function editable(id: string, agent: string, statuses: Project['status'][]) {
    await active.get(id)
    const p = await project(id)
    const stage = await currentStage(id)
    if (!statuses.includes(p.status) || !stage?.agents.some((a) => a.id === agent)) throw new Error('Solo se puede intervenir a un agente de la etapa actual, con el proyecto detenido')
    return stage
  }

  /** Relanza un agente de la etapa actual con una nota. El proyecto debe estar pausado. */
  async function rerun(id: string, agent: string, note: string) {
    if (!note.trim()) throw new Error('Relanzar un agente necesita una nota')
    const stage = await editable(id, agent, ['paused'])
    await sendBack(id, stage, [agent], note)
    await setStage(id, stage.id, 'working')
    await resume(id)
  }

  /** Vuelve a una versión anterior: la copia como versión nueva, sin sobrescribir, y el auditor revisa de nuevo. */
  async function restore(id: string, agent: string, version: number) {
    const stage = await editable(id, agent, ['paused', 'waiting_human'])
    const def = stage.agents.find((a) => a.id === agent)!
    const latest = (await latestSteps(id)).get(`${stage.id}/${agent}`)
    if (!latest || version >= latest.version || !(await one('SELECT 1 AS ok FROM steps WHERE project_id = ? AND stage = ? AND agent = ? AND version = ?', id, stage.id, agent, version))) throw new Error('Esa versión no existe o ya es la vigente')
    const next = latest.version + 1
    const from = stepDir(id, stage.id, agent, version), to = stepDir(id, stage.id, agent, next)
    const names = await files.list(from)
    await Promise.all(names.map((f) => files.copy(`${from}/${f}`, `${to}/${f}`)))
    await copyAssets(id, from, to, names)
    if (latest.status === 'done') await sendBack(id, stage, [agent], `Sustituida por la versión ${version}`)
    await saveStep(id, stage.id, agent, next, `copia de la versión ${version}`)
    await emit(id, 'agent.done', { stage: stage.id, agent, version: next, to: stage.auditor.id, files: [...new Set([...def.deliverables, ...names.filter((f) => f !== 'handoff.json')])], restoredFrom: version })
    await setStage(id, stage.id, 'working', 0)
    await setStatus(id, 'running')
    kick(id)
  }

  /** Tras reiniciar el servidor: retoma los proyectos que estaban en marcha. La promesa termina cuando todos se detienen. */
  async function resumeAll() {
    return Promise.all((await db("SELECT id FROM projects WHERE status = 'running'")).map((r) => advance(r.id)))
  }

  async function getProject(id: string) {
    const [p, stages, steps] = await Promise.all([
      project(id),
      db('SELECT stage, status, attempts FROM stages WHERE project_id = ?', id) as Promise<StageRow[]>,
      db('SELECT stage, agent, version, status, feedback, model FROM steps WHERE project_id = ? ORDER BY done_at, version', id) as Promise<StepRow[]>,
    ])
    const done = new Set(stages.filter((s) => s.status === 'approved').map((s) => s.stage))
    return { ...p, currentStage: schemes[p.scheme].stages.find((s) => !done.has(s.id))?.id ?? null, stages, steps }
  }

  const listProjects = (): Promise<Project[]> => db('SELECT * FROM projects ORDER BY created_at DESC')

  return { advance, resumeAll, createProject, getProject, listProjects, listBrands, brandByName, addBrandAsset, listAssets, decide, pause, resume, cancel, rerun, restore, getSettings, setSettings, eventsAfter, files, schemes }
}

export type Engine = ReturnType<typeof createEngine>
