import { DEFAULT_MODEL, MODELS, usdByKind, type Usage } from './models.ts'
import { DEFAULT_IMAGE, DEFAULT_VIDEO, IMAGE_MODELS, VIDEO_MODELS, imageModel } from '../media/prices.ts'
import { ASPECTS, type Aspect, type Explorer } from '../explore.ts'
import { randomBytes, randomUUID } from 'node:crypto'
import { plainReporter, type Reporter } from '../report.ts'
import { TIMEOUT_MIN, brandDir, readReferences, type AuditRun, type AgentDef, type Asset, type Brand, type Db, type Ev, type Files, type Input, type NewAsset, type Project, type Runner, type Scheme, type StageDef } from './types.ts'

export type Board = { id: string; title: string; prompt: string; note: string; aspect: Aspect; withProduct: boolean; images: { file: string; selected: boolean }[] }
export type Exploration = { idea: string; boards: Board[] }
export type Settings = { humanReview: boolean; simulation: boolean; models: Record<string, string>; maxAuditRetries: number; textTimeoutMin: number; mediaTimeoutMin: number; defaultBudget: number; imageModel: string; videoModel: string; parallelAgents: boolean }
const DEFAULTS: Settings = { humanReview: true, simulation: true, models: {}, maxAuditRetries: 2, textTimeoutMin: TIMEOUT_MIN.text, mediaTimeoutMin: TIMEOUT_MIN.media, defaultBudget: 50, imageModel: DEFAULT_IMAGE, videoModel: DEFAULT_VIDEO, parallelAgents: false }

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

/** Así empieza la indicación que recibe un agente cuando lo que cambió fue el trabajo de otro, anterior al suyo. */
const CASCADE = 'Se devolvió trabajo anterior al tuyo'

export function createEngine(opts: {
  db: Db
  files: Files
  schemes: Record<string, Scheme>
  runner: Runner
  maxAuditRetries?: number
  maxContractRetries?: number
  /** Quién escribe la memoria de producción para el cliente. Sin él, o en simulación, se usa una plantilla. */
  reporter?: Reporter
  /** Quien propone y genera las opciones de la exploración. Sin él, los proyectos arrancan directo. */
  explorer?: Explorer
  /** Se llama con cada evento ya guardado, para los avisos fuera de la app. Un fallo aquí no afecta al motor. */
  onEvent?: (projectId: string, type: string, data: Record<string, any>) => void
}) {
  const { db, files, schemes, runner } = opts
  // El proyecto tal como lo ve el agente que está corriendo: subir el tope a mitad de trabajo se refleja aquí.
  const live = new Map<string, Project>()
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
    return next.then(() => { try { opts.onEvent?.(projectId, type, data) } catch { /* un aviso que falla no detiene nada */ } })
  }
  /** Lo que un agente dice en la oficina es accesorio: si no se puede guardar, el trabajo sigue. */
  const chatter = (projectId: string, stage: string, agent: string, text: string) => void emit(projectId, 'agent.message', { stage, agent, text }).catch(() => {})

  async function eventsAfter(projectId: string, after = 0): Promise<Ev[]> {
    const rows = await db('SELECT * FROM events WHERE project_id = ? AND id > ? ORDER BY id', projectId, after)
    return rows.map((r) => ({ id: Number(r.id), projectId: r.project_id, ts: r.ts, type: r.type, data: JSON.parse(r.data) }))
  }

  async function getSettings(): Promise<Settings> {
    const rows = await db('SELECT key, value FROM settings')
    return { ...DEFAULTS, maxAuditRetries, ...Object.fromEntries(rows.filter((r) => Object.hasOwn(DEFAULTS, r.key)).map((r) => [r.key, JSON.parse(r.value)])) }
  }

  /** `models` llega por agente y se fusiona con lo guardado: `null` o el modelo por defecto quitan la elección. */
  async function setSettings(patch: Partial<Omit<Settings, 'models'>> & { models?: Record<string, string | null> }) {
    const flag = (v: unknown) => typeof v === 'boolean'
    const whole = (min: number, max: number) => (v: unknown) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max
    const known = new Set(Object.values(schemes).flatMap((s) => s.stages.flatMap((st) => [...st.agents, st.auditor].map((a) => a.id))))
    const valid: Record<keyof Settings, (v: unknown) => boolean> = {
      humanReview: flag, simulation: flag, parallelAgents: flag,
      models: (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.entries(v as object).every(([agent, model]) => known.has(agent) && (model === null || (typeof model === 'string' && Object.hasOwn(MODELS, model)))),
      maxAuditRetries: whole(0, 5), textTimeoutMin: whole(5, 60), mediaTimeoutMin: whole(15, 180), defaultBudget: whole(1, 10_000),
      imageModel: (v) => typeof v === 'string' && Object.hasOwn(IMAGE_MODELS, v), videoModel: (v) => typeof v === 'string' && Object.hasOwn(VIDEO_MODELS, v),
    }
    // Primero se valida todo: un valor malo no deja guardado a medias lo demás.
    const keys = (Object.keys(DEFAULTS) as (keyof Settings)[]).filter((k) => patch[k] !== undefined)
    for (const key of keys) if (!valid[key](patch[key])) throw new Error(`Ese valor no sirve para ${key}`)
    const next: Record<string, unknown> = { ...patch }
    // Al fusionar se descarta lo que ya no existe (un agente o un modelo retirado), para que no bloquee cambios futuros.
    if (patch.models) next.models = Object.fromEntries(Object.entries({ ...(await getSettings()).models, ...patch.models }).filter(([agent, model]) => known.has(agent) && typeof model === 'string' && model !== DEFAULT_MODEL && Object.hasOwn(MODELS, model)))
    for (const key of keys) await db('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(next[key]))
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

  /**
   * Cambia de estado solo si el proyecto sigue donde se le vio. Entre leer el estado y escribirlo pasan idas a la
   * base: sin esta condición, una cancelación que llegara en medio quedaría pisada y el proyecto volvería a gastar.
   */
  async function move(id: string, from: Project['status'] | Project['status'][], status: Project['status'], reason: string | null = null) {
    const list = [from].flat()
    const changed = await db(`UPDATE projects SET status = ?, reason = ? WHERE id = ? AND status IN (${list.map(() => '?').join(',')}) RETURNING id`, status, reason, id, ...list)
    if (changed.length) await emit(id, 'project.status', { status, reason })
    return changed.length > 0
  }
  const pauseIfRunning = async (id: string, reason: string): Promise<void> => void (await move(id, 'running', 'paused', reason))

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

  async function addCost(id: string, stage: string, agent: string, usd: number, use?: Usage) {
    if (!(usd > 0)) return
    // El proyecto que ven los agentes en curso refleja el gasto al instante: en paralelo, cada uno ve lo que gastan los demás.
    const running = live.get(id)
    if (running) running.spent += usd
    await db('UPDATE projects SET spent = spent + ? WHERE id = ?', usd, id)
    await emit(id, 'cost', { stage, agent, usd, spent: (await project(id)).spent, ...(use ? { tokens: use, tokensUsd: usdByKind(use) } : {}) })
  }

  const saveStep = (id: string, stage: string, agent: string, version: number, model: string) =>
    db('INSERT INTO steps (project_id, stage, agent, version, status, model, done_at) VALUES (?,?,?,?,?,?,?)', id, stage, agent, version, 'done', model, now())

  /**
   * Deja lista la carpeta de una versión nueva. Si hay una versión anterior, parte de una copia de sus archivos:
   * así el agente rehace solo lo que le devolvieron (un plano, una línea de voz) y no paga otra vez por todo.
   * Devuelve si la carpeta ya traía archivos de un intento interrumpido de esta misma versión.
   */
  async function prepareDir(id: string, stage: string, agent: string, version: number, dir: string) {
    // Si la carpeta ya tiene archivos es que un intento anterior se interrumpió (caída, error, tiempo agotado).
    // Lo que alcanzó a generar ya se pagó: se conserva, y de la versión anterior se trae solo lo que falte.
    const have = new Set(await files.list(dir))
    if (version === 1) return have.size > 0
    const prev = stepDir(id, stage, agent, version - 1)
    const names = (await files.list(prev)).filter((f) => f !== 'handoff.json' && !have.has(f))
    await Promise.all(names.map((f) => files.copy(`${prev}/${f}`, `${dir}/${f}`)))
    await copyAssets(id, prev, dir, names)
    return have.size > 0
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

  /** El traspaso de un agente real dice qué archivos tocó en esa ejecución. El simulado no lo dice y no se le exige. */
  async function unchanged(dir: string) {
    try {
      const { changed } = JSON.parse((await files.read(`${dir}/handoff.json`)) ?? '')
      return Array.isArray(changed) && changed.length === 0
    } catch {
      return false
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
    let nudged = false
    let failures = 0
    let feedback = prev?.feedback ?? null
    // Tras un intento interrumpido el agente puede encontrar su trabajo ya hecho: no tocar nada es entonces lo correcto.
    const resumed = await prepareDir(p.id, stage.id, agent.id, version, dir)
    for (let attempt = 0; ; attempt++) {
      // El gasto se relee en cada intento: el anterior pudo consumir casi todo el tope.
      // Se actualiza el mismo objeto, no uno nuevo: es el que comparten los agentes que corren a la vez.
      const fresh = attempt === 0 ? p : Object.assign(p, await project(p.id))
      if (fresh.spent >= fresh.budget_cap) return false
      await emit(p.id, 'agent.started', { stage: stage.id, agent: agent.id, version, feedback })
      live.set(p.id, fresh)
      const cfg = await getSettings()
      const result = await runner.runAgent({
        project: fresh, stage, agent, version, dir, to, files, brand,
        media: { image: cfg.imageModel, video: cfg.videoModel },
        model: cfg.models[agent.id], timeoutMs: (agent.tools?.length ? cfg.mediaTimeoutMin : cfg.textTimeoutMin) * 60_000,
        inputs: inputsFor(p.id, latest, scheme, stage, agent),
        feedback,
        say: (text) => chatter(p.id, stage.id, agent.id, text),
        spend: (usd, use) => addCost(p.id, stage.id, agent.id, usd, use),
        record: (asset) => recordAsset(p.id, asset),
        assets: () => listAssets(p.id),
        signal: aborts.get(p.id)!.signal,
      })
      model = result.model
      await addCost(p.id, stage.id, agent.id, result.costUsd)
      let problem = await checkContract(files, dir, agent)
      // Como una versión nueva parte de la copia de la anterior, un agente puede darla por corregida sin tocar nada
      // y el contrato no lo nota. Se le avisa una vez; si insiste en que no hay nada que cambiar, se acepta y lo juzga el auditor.
      const real = Boolean(problem)
      if (!problem && !nudged && !resumed && prev?.feedback && !prev.feedback.startsWith(CASCADE) && (await unchanged(dir))) {
        nudged = true
        problem = 'te devolvieron el trabajo y terminaste sin escribir ni generar ningún archivo: tus entregables siguen siendo los de la versión anterior. Reescribe los que deban cambiar, o explica en tu resumen por qué ninguno cambia'
      }
      if (!problem) break
      await emit(p.id, 'contract.failed', { stage: stage.id, agent: agent.id, version, problem })
      // El aviso por no haber cambiado nada no es un incumplimiento: no gasta reintentos de contrato.
      if (real && failures++ >= maxContractRetries) throw new Error(`${agent.name} no cumplió el contrato de entrega: ${problem}`)
      // El reintento conserva la carpeta y le dice al agente qué faltó, para que no rehaga (ni pague) todo.
      feedback = `${prev?.feedback ? `${prev.feedback}\n` : ''}Tu entrega quedó incompleta: ${problem}. Completa solo lo que falta.`
    }
    await saveStep(p.id, stage.id, agent.id, version, model)
    // La lista real de archivos: los entregables fijos más lo que el agente generó con herramientas.
    const produced: string[] = JSON.parse((await files.read(`${dir}/handoff.json`))!).files
    await emit(p.id, 'agent.done', { stage: stage.id, agent: agent.id, version, to, files: [...new Set([...agent.deliverables, ...produced])] })
    return true
  }

  async function sendBack(id: string, stage: StageDef, agents: string[], feedback: string) {
    const latest = await latestSteps(id)
    for (const agent of agents) {
      const step = latest.get(`${stage.id}/${agent}`)
      if (step) await db('UPDATE steps SET status = ?, feedback = ? WHERE project_id = ? AND stage = ? AND agent = ? AND version = ?', 'rejected', feedback, id, stage.id, agent, step.version)
    }
  }

  /** Una pasada del auditor de la etapa: para auditar, o con `request` para repartir una mejora. Deja registrado lo que costó. */
  async function askAuditor(p: Project, scheme: Scheme, stage: StageDef, latest: Map<string, StepRow>, extra: Pick<AuditRun, 'request' | 'previous'> = {}) {
    const auditor = stage.auditor.id
    await emit(p.id, 'audit.started', { stage: stage.id, auditor })
    live.set(p.id, p)
    const cfg = await getSettings()
    const verdict = await runner.runAuditor({
      project: p, stage, files, brand: await brandOf(p), ...extra,
      model: cfg.models[auditor], timeoutMs: cfg.mediaTimeoutMin * 60_000,
      deliverables: inputsFor(p.id, latest, scheme, stage).filter((i) => i.stage === stage.id),
      say: (text) => chatter(p.id, stage.id, auditor, text),
      assets: () => listAssets(p.id),
      spend: (usd, use) => addCost(p.id, stage.id, auditor, usd, use),
      signal: aborts.get(p.id)!.signal,
    })
    await addCost(p.id, stage.id, auditor, verdict.costUsd)
    return { verdict, cfg, auditor }
  }

  async function audit(p: Project, scheme: Scheme, stage: StageDef, row: StageRow, latest: Map<string, StepRow>) {
    // En un reintento el auditor recibe su último rechazo de esta etapa.
    const last = row.attempts > 0 ? (await db("SELECT data FROM events WHERE project_id = ? AND type = 'audit.verdict' ORDER BY id DESC LIMIT 30", p.id)).map((r) => JSON.parse(r.data)).find((d) => d.stage === stage.id && !d.approved && !d.improvement) : null
    const { verdict, cfg, auditor } = await askAuditor(p, scheme, stage, latest, last ? { previous: { attempt: Number(last.attempt) || row.attempts, issues: last.issues ?? [] } } : {})
    // Un rechazo sin agente válido señalado devuelve el trabajo a toda la etapa.
    const known = verdict.issues.filter((i) => stage.agents.some((a) => a.id === i.agent))
    const issues = verdict.approved ? [] : known.length ? known : stage.agents.map((a) => ({ agent: a.id, problem: verdict.issues[0]?.problem ?? 'El auditor rechazó la etapa sin detalle' }))
    await emit(p.id, 'audit.verdict', { stage: stage.id, auditor, approved: verdict.approved, issues, attempt: row.attempts + 1 })
    if (verdict.approved) return setStage(p.id, stage.id, 'audited')
    if (row.attempts >= cfg.maxAuditRetries) return setStage(p.id, stage.id, 'escalated')
    // Varios problemas para un mismo agente llegan juntos: guardarlos uno a uno dejaría solo el último.
    const byAgent = Map.groupBy(issues, (i) => i.agent)
    for (const [agent, list] of byAgent) await sendBack(p.id, stage, [agent], list.map((i) => i.problem).join('\n'))
    await setStage(p.id, stage.id, 'working', row.attempts + 1)
  }

  /** Avanza desde el estado guardado hasta terminar o necesitar a una persona. */
  async function loop(id: string) {
    const scheme = schemes[(await project(id)).scheme]
    // Una mejora pedida sobre la pieza entregada reabre etapas antes de recorrerlas.
    await planImprovement(id, scheme)
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
          const latest = await latestSteps(id)
          const waiting = (a: AgentDef) => latest.get(`${stage.id}/${a.id}`)?.status !== 'done'
          const pending = stage.agents.find(waiting)
          // El tope se comprueba antes de cada agente, de cada reintento y de cada auditoría.
          if (p.spent >= p.budget_cap) return pauseIfRunning(id, 'budget')
          if (pending) {
            // Con el trabajo en paralelo activado, corren a la vez los agentes que el esquema marca como independientes del anterior.
            // ponytail: el tope se comprueba antes de cada generación con el gasto de todos; dos que se lancen en el mismo instante pueden pasarlo por el costo de una.
            const wave = [pending]
            if ((await getSettings()).parallelAgents) for (let i = stage.agents.indexOf(pending) + 1; stage.agents[i]?.alongside; i++) if (waiting(stage.agents[i])) wave.push(stage.agents[i])
            const runs = await Promise.allSettled(wave.map((a) => runStep(p, scheme, stage, a, latest)))
            const failed = runs.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
            if (failed) throw failed.reason
            if (runs.some((r) => r.status === 'fulfilled' && !r.value)) return pauseIfRunning(id, 'budget')
          }
          else await audit(p, scheme, stage, row, latest)
        } else if (row.status === 'audited' && !(await getSettings()).humanReview) {
          await setStage(id, stage.id, 'approved')
          await emit(id, 'stage.approved', { stage: stage.id, by: 'auditor' })
        } else {
          return void (await move(id, 'running', 'waiting_human', row.status === 'escalated' ? 'escalated' : 'gate'))
        }
      }
    }
    // Pudo cancelarse o pausarse mientras se cerraba la última etapa.
    await move(id, 'running', 'done')
  }

  /** Un solo recorrido por proyecto a la vez dentro de este proceso. */
  function advance(id: string): Promise<void> {
    let job = active.get(id)
    if (!job) {
      aborts.set(id, new AbortController())
      let unrecorded = false
      job = loop(id)
        .catch(async (err) => {
          // Solo un proyecto en marcha pasa a detenido: si la persona lo canceló o pausó, esa decisión se respeta.
          // Quedarse sin dinero a mitad de un agente no es un fallo: es la misma pausa por tope, y al reanudar retoma lo hecho.
          if (err instanceof Error && err.name === 'BudgetError') return pauseIfRunning(id, 'budget')
          const reason = err instanceof Error ? err.message : String(err)
          const changed = await db("UPDATE projects SET status = 'failed', reason = ? WHERE id = ? AND status = 'running' RETURNING id", reason, id)
          if (changed.length) await emit(id, 'project.status', { status: 'failed', reason })
        })
        .catch((err) => { unrecorded = true; console.error(`No se pudo registrar el fallo del proyecto ${id}:`, err) })
        .finally(async () => {
          active.delete(id)
          aborts.delete(id)
          // Una reanudación que llegó justo cuando este recorrido terminaba no encontró sitio: se atiende ahora.
          // Si el fallo ni siquiera se pudo anotar, el estado sigue "en marcha" por error: insistir sería un bucle sin fin.
          if (!unrecorded && (await one('SELECT status FROM projects WHERE id = ?', id).catch(() => null))?.status === 'running') kick(id)
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

  const listReferences = (id: string) => readReferences(files, id)
  const MAX_REFERENCES = 30

  /** Guarda una foto de referencia del proyecto. El nombre lo pone el motor; la nota es la indicación de la persona. */
  async function addReference(id: string, bytes: Uint8Array, ext: string, contentType: string, note: string, stage?: string) {
    const p = await project(id)
    if (['done', 'cancelled'].includes(p.status)) throw new Error('El proyecto ya terminó: no admite más referencias')
    // ponytail: lista en un solo archivo, sin bloqueo; dos subidas simultáneas al mismo proyecto podrían pisarse. Pasar a una tabla si ocurre.
    const refs = await listReferences(id)
    if (refs.length >= MAX_REFERENCES) throw new Error(`El proyecto ya tiene ${MAX_REFERENCES} fotos de referencia`)
    const file = `referencias/ref-${refs.length + 1}${ext}`
    await files.writeBytes(`${id}/${file}`, bytes, contentType)
    refs.push({ file, note, stage: stage ?? (await currentStage(id))?.name ?? '' })
    await files.write(`${id}/referencias/notas.json`, JSON.stringify(refs))
    return refs
  }

  async function createProject(input: { name: string; brief: string; budgetCap: number; explore?: boolean; templateId?: string; scheme?: string; brand?: { name: string; kit: string }; references?: { bytes: Uint8Array; ext: string; contentType: string; note: string }[] }) {
    const scheme = input.scheme ?? 'commercial'
    if (!schemes[scheme]) throw new Error(`Esquema desconocido: ${scheme}`)
    // La biblioteca de marca se guarda por cliente y se reutiliza en sus siguientes proyectos.
    if (input.brand) await db('INSERT INTO brands (name, kit) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET kit = excluded.kit', input.brand.name, input.brand.kit)
    if (input.templateId) await project(input.templateId)
    const id = `p_${randomUUID().slice(0, 8)}`
    // Con exploración el proyecto espera: nada corre ni gasta hasta que una persona pulse "Iniciar producción".
    const status: Project['status'] = input.explore && opts.explorer ? 'exploring' : 'running'
    // El modo se fija al crear: cambiar el interruptor después no convierte un proyecto simulado en uno que gasta.
    const { simulation } = await getSettings()
    await db('INSERT INTO projects (id, name, brief, scheme, brand, status, budget_cap, created_at, simulation) VALUES (?,?,?,?,?,?,?,?,?)', id, input.name, input.brief, scheme, input.brand?.name ?? null, status, input.budgetCap, now(), simulation)
    // Las referencias se guardan antes de arrancar: el primer agente de la primera etapa ya las recibe.
    for (const r of input.references ?? []) await addReference(id, r.bytes, r.ext, r.contentType, r.note, '')
    // Partir de una producción anterior: sus referencias (el look ya aprobado) pasan a la nueva, hasta donde quepan.
    if (input.templateId) for (const r of (await readReferences(files, input.templateId)).slice(0, MAX_REFERENCES - (input.references?.length ?? 0))) {
      const bytes = await files.readBytes(`${input.templateId}/${r.file}`)
      if (bytes) await addReference(id, bytes, r.file.slice(r.file.lastIndexOf('.')), r.file.endsWith('.png') ? 'image/png' : 'image/jpeg', r.note, '')
    }
    await emit(id, 'project.status', { status, reason: null })
    if (status === 'running') kick(id)
    return project(id)
  }

  /** Decisión de una persona en un gate o tras una escalada del auditor. */
  async function decide(id: string, d: { approve: boolean; comment?: string; agents?: string[]; references?: string[] }) {
    const [p, stage] = await Promise.all([project(id), currentStage(id)])
    if (p.status !== 'waiting_human' || !stage) throw new Error('El proyecto no está esperando una decisión')
    if (!d.approve && !d.comment?.trim()) throw new Error('Un rechazo necesita un comentario')
    const scheme = schemes[p.scheme]
    const reachable = scheme.stages.slice(0, scheme.stages.indexOf(stage) + 1).flatMap((s) => s.agents.map((a) => a.id))
    const agents = Array.isArray(d.agents) ? d.agents : []
    const unknown = agents.filter((a) => !reachable.includes(a))
    if (!d.approve && unknown.length) throw new Error(`No se puede devolver trabajo a ${unknown.join(', ')}: no es de esta etapa ni de una anterior`)
    // Toma la decisión una sola vez: un doble clic o una cancelación simultánea no la repiten ni la pisan.
    // Las fotos adjuntas a una devolución se nombran en la indicación, para que quien repite sepa cuáles mirar.
    const known = d.references?.length ? (await listReferences(id)).map((r) => r.file) : []
    const attached = (d.references ?? []).filter((f) => known.includes(f))
    if (attached.length && d.comment) d = { ...d, comment: `${d.comment}\nFotos de referencia para esta corrección, míralas con view_media antes de empezar: ${attached.join(', ')}` }
    if (!(await move(id, 'waiting_human', 'running'))) throw new Error('El proyecto no está esperando una decisión')
    await emit(id, 'gate.decided', { stage: stage.id, approve: d.approve, comment: d.comment ?? null })
    if (d.approve) {
      await setStage(id, stage.id, 'approved')
      await emit(id, 'stage.approved', { stage: stage.id, by: 'human' })
    } else {
      await returnWork(id, scheme, stage, agents, d.comment!)
    }
    kick(id)
  }

  /**
   * Devuelve trabajo a los agentes elegidos, que pueden ser de la etapa actual o de una anterior ya aprobada
   * (una toma que hay que generar de nuevo se descubre a veces en el montaje). Todo lo que se hizo después de
   * ellos depende de su entrega, así que también se actualiza: esos agentes parten de sus archivos anteriores
   * y rehacen solo lo que cambia. Las etapas reabiertas vuelven a pasar por su auditor y su aprobación.
   */
  async function returnWork(id: string, scheme: Scheme, current: StageDef, agents: string[], comment: string) {
    const upTo = scheme.stages.indexOf(current)
    const order = scheme.stages.slice(0, upTo + 1).flatMap((s) => s.agents.map((a) => ({ stage: s, agent: a })))
    const chosen = order.filter((o) => agents.includes(o.agent.id))
    // Sin nadie señalado, se repite toda la etapa actual.
    const targets = chosen.length ? chosen : order.filter((o) => o.stage === current)
    const first = order.indexOf(targets[0])
    const names = targets.map((t) => t.agent.name).join(', ')
    const reopensEarlier = targets.some((t) => t.stage !== current)
    const reopened = new Set<StageDef>()
    for (const [i, o] of order.entries()) {
      if (i < first) continue
      const direct = targets.includes(o)
      // Dentro de la etapa actual la persona elige exactamente quién repite. El arrastre a los demás
      // solo ocurre cuando se reabre una etapa anterior, porque entonces cambia la base de todo lo posterior.
      if (!direct && !reopensEarlier) continue
      await sendBack(id, o.stage, [o.agent.id], direct ? comment : `${CASCADE} (${names}) con esta indicación: ${comment}\nRevisa lo que entreguen de nuevo y actualiza tu entrega solo en lo que dependa de ello. Lo demás se conserva.`)
      reopened.add(o.stage)
    }
    for (const s of reopened) await setStage(id, s.id, 'working', 0)
    if (reopened.size > 1) await emit(id, 'stages.reopened', { stages: [...reopened].map((s) => s.id), agents: targets.map((t) => t.agent.id) })
  }

  async function pause(id: string) {
    if (!(await move(id, 'running', 'paused', 'manual'))) throw new Error('Solo se puede pausar un proyecto en marcha')
  }

  /** Cambia el tope sin detener nada. El agente que esté trabajando lo nota en su siguiente generación. */
  async function setBudget(id: string, budgetCap: number) {
    const p = await project(id)
    if (p.status === 'done' || p.status === 'cancelled') throw new Error('El proyecto ya terminó')
    if (budgetCap <= p.spent) throw new Error(`El tope nuevo debe ser mayor que lo ya gastado ($${p.spent.toFixed(2)})`)
    await db('UPDATE projects SET budget_cap = ? WHERE id = ?', budgetCap, id)
    const working = live.get(id)
    if (working) working.budget_cap = budgetCap
    return project(id)
  }

  async function resume(id: string, budgetCap?: number) {
    const p = await project(id)
    if (p.status !== 'paused' && p.status !== 'failed') throw new Error('El proyecto no está pausado')
    if (budgetCap !== undefined && budgetCap <= p.spent) throw new Error(`El tope nuevo debe ser mayor que lo ya gastado ($${p.spent.toFixed(2)})`)
    if (budgetCap !== undefined) await db('UPDATE projects SET budget_cap = ? WHERE id = ?', budgetCap, id)
    if (!(await move(id, ['paused', 'failed'], 'running'))) throw new Error('El proyecto no está pausado')
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


  // ---------------------------------------------------------------- Administración: costos, limpieza y vistas previas

  /** Todas las producciones con lo necesario para compararlas de un vistazo. */
  async function overview() {
    const rows = await db(`SELECT p.*,
      (SELECT count(*)::int FROM stages s WHERE s.project_id = p.id AND s.status = 'approved') AS approved,
      (SELECT count(*)::int FROM steps t WHERE t.project_id = p.id) AS runs,
      (SELECT count(*)::int FROM steps t WHERE t.project_id = p.id AND t.version > 1) AS reworks,
      (SELECT coalesce(sum(a.cost_usd), 0) FROM assets a WHERE a.project_id = p.id) AS generation,
      (SELECT a.path FROM assets a WHERE a.project_id = p.id AND a.path LIKE '%/master.mp4' ORDER BY a.id DESC LIMIT 1) AS master,
      (SELECT count(*)::int FROM shares h WHERE h.project_id = p.id AND h.revoked_at IS NULL AND h.expires_at > ?) AS shares,
      (SELECT max(e.ts) FROM events e WHERE e.project_id = p.id) AS last_activity
      FROM projects p ORDER BY p.created_at DESC`, now())
    return rows.map((r) => ({ ...r, spent: Number(r.spent), budget_cap: Number(r.budget_cap), generation: Number(r.generation), stages: schemes[r.scheme]?.stages.length ?? 0 }))
  }

  /**
   * En qué se fue el dinero de una producción. Cada ejecución de un agente o de un auditor es una fila;
   * "repetición" es toda ejecución que no fue la primera de ese agente o la primera auditoría de su etapa.
   */
  async function costReport(id: string) {
    const p = await project(id)
    const scheme = schemes[p.scheme]
    const names = new Map(scheme.stages.flatMap((s) => [...s.agents, s.auditor].map((a) => [a.id, a.name] as const)))
    type Run = { stage: string; who: string; name: string; kind: 'agente' | 'auditor' | 'memoria' | 'exploracion'; n: number; usd: number; repeat: boolean; startedAt: string; endedAt: string }
    const runs: Run[] = []
    // Tokens de Claude medidos, y lo que costó cada tipo. Los proyectos anteriores a esta medición no los tienen.
    const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    const tokensUsd = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    const byModel = new Map<string, number>()
    const open = new Map<string, Run>()
    const evs = await db("SELECT type, data, ts FROM events WHERE project_id = ? AND type IN ('agent.started','audit.started','cost') ORDER BY id", id)
    for (const e of evs) {
      const d = JSON.parse(e.data)
      if (e.type === 'cost') {
        let run = open.get(d.agent)
        // Un costo sin ejecución abierta es la memoria para el cliente u otro gasto fuera del recorrido.
        if (!run) { run = { stage: d.stage, who: d.agent, name: names.get(d.agent) ?? (d.agent === 'exploration' ? 'Exploración de referencias' : 'Memoria para el cliente'), kind: d.agent === 'exploration' ? 'exploracion' : 'memoria', n: 1, usd: 0, repeat: false, startedAt: e.ts, endedAt: e.ts }; runs.push(run); if (d.agent === 'exploration') open.set(d.agent, run) }
        run.usd += d.usd
        run.endedAt = e.ts
        if (d.tokens) {
          const part = d.tokensUsd ?? usdByKind(d.tokens)
          for (const k of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) { tokens[k] += d.tokens[k]; tokensUsd[k] += part[k] }
          byModel.set(d.tokens.model, (byModel.get(d.tokens.model) ?? 0) + d.usd)
        }
        continue
      }
      const who = e.type === 'agent.started' ? d.agent : d.auditor
      const kind = e.type === 'agent.started' ? 'agente' : 'auditor'
      const before = runs.filter((r) => r.who === who && r.stage === d.stage).length
      const run: Run = { stage: d.stage, who, name: names.get(who) ?? who, kind, n: kind === 'agente' ? d.version : before + 1, usd: 0, repeat: before > 0, startedAt: e.ts, endedAt: e.ts }
      runs.push(run)
      open.set(who, run)
    }
    const sum = (list: Run[]) => list.reduce((a, r) => a + r.usd, 0)
    const generation = (await db('SELECT provider, tool, count(*)::int AS files, coalesce(sum(cost_usd), 0) AS usd FROM assets WHERE project_id = ? AND cost_usd > 0 GROUP BY provider, tool ORDER BY usd DESC', id)).map((r) => ({ provider: r.provider, tool: r.tool, files: r.files, usd: Number(r.usd) }))
    const generationUsd = generation.reduce((a, g) => a + g.usd, 0)
    const byAgent = [...Map.groupBy(runs, (r) => r.who)].map(([who, list]) => ({ id: who, name: list[0].name, stage: list[0].stage, kind: list[0].kind, usd: sum(list), runs: list.length, repeats: list.filter((r) => r.repeat).length })).sort((a, b) => b.usd - a.usd)
    const byStage = scheme.stages.map((s) => {
      const list = runs.filter((r) => r.stage === s.id)
      return { id: s.id, name: s.name, usd: sum(list), firstPassUsd: sum(list.filter((r) => !r.repeat)), reworkUsd: sum(list.filter((r) => r.repeat)), runs: list.length, repeats: list.filter((r) => r.repeat).length }
    })
    const audits = await db("SELECT data FROM events WHERE project_id = ? AND type = 'audit.verdict' ORDER BY id", id)
    const times = await db('SELECT min(ts) AS first, max(ts) AS last FROM events WHERE project_id = ?', id)
    return {
      project: p,
      totalUsd: p.spent,
      generationUsd,
      // Lo demás es Claude: los agentes, los auditores y la revisión de video.
      modelUsd: Math.max(p.spent - generationUsd, 0),
      tokens, tokensUsd,
      byModel: [...byModel].map(([model, usd]) => ({ model: MODELS[model]?.name ?? model, usd })),
      firstPassUsd: sum(runs.filter((r) => !r.repeat)),
      reworkUsd: sum(runs.filter((r) => r.repeat)),
      rejections: audits.filter((a) => !JSON.parse(a.data).approved).length,
      startedAt: times[0]?.first ?? null,
      lastActivityAt: times[0]?.last ?? null,
      byStage, byAgent, generation, runs,
    }
  }

  /** Borra una producción con todos sus archivos. No se puede deshacer. */
  async function deleteProject(id: string) {
    await active.get(id)
    const p = await project(id)
    if (p.status === 'running') throw new Error('Pausa o cancela la producción antes de borrarla')
    const dirs = new Set((await db('SELECT stage, agent, version FROM steps WHERE project_id = ?', id)).map((r) => stepDir(id, r.stage, r.agent, r.version)))
    // Carpetas de intentos que no llegaron a registrarse como paso, y la de la memoria para el cliente.
    for (const a of await db('SELECT DISTINCT path FROM assets WHERE project_id = ?', id)) dirs.add(`${id}/${a.path.split('/').slice(0, -1).join('/')}`)
    dirs.add(`${id}/client`)
    dirs.add(`${id}/referencias`)
    dirs.add(`${id}/mejoras`)
    dirs.add(`${id}/${EXPLORE}`)
    for (const dir of dirs) await files.removeDir(dir)
    for (const table of ['shares', 'assets', 'events', 'steps', 'stages', 'finance_entries']) await db(`DELETE FROM ${table} WHERE project_id = ?`, id)
    await db('DELETE FROM projects WHERE id = ?', id)
    queues.delete(id)
  }

  /** Los videos que se le enseñan al cliente: la pieza principal y las versiones de entrega vigentes. */
  async function clientVideos(id: string) {
    const assets = (await listAssets(id)).filter((a) => a.kind === 'video')
    const latest = await latestSteps(id)
    const dirOf = (stage: string, agent: string) => { const s = latest.get(`${stage}/${agent}`); return s ? `${stage}/${agent}/v${s.version}/` : null }
    const master = dirOf('postproduction', 'motion-graphics')
    const versions = dirOf('delivery', 'versioning')
    const label = (a: Asset) => { const m = a.measurements; return !m?.width || !m.height ? 'Versión' : m.width > m.height ? 'Horizontal 16:9' : m.width < m.height ? 'Vertical 9:16' : 'Cuadrado 1:1' }
    const out: { path: string; label: string; seconds: number | null; width: number | null; height: number | null }[] = []
    const add = (a: Asset, text: string) => out.push({ path: a.path, label: text, seconds: a.measurements?.durationSeconds ?? null, width: a.measurements?.width ?? null, height: a.measurements?.height ?? null })
    const main = master ? assets.find((a) => a.path === `${master}master.mp4`) : undefined
    if (main) add(main, 'Pieza principal')
    if (versions) for (const a of assets.filter((x) => x.path.startsWith(versions))) add(a, label(a))
    return out
  }

  const REPORT = 'client/report.md'
  /** La memoria de producción para el cliente. Se escribe una vez y se guarda; `fresh` la vuelve a escribir. */
  async function clientReport(id: string, fresh = false): Promise<string> {
    const path = `${id}/${REPORT}`
    if (!fresh) { const saved = await files.read(path); if (saved) return saved }
    const p = await project(id)
    const latest = await latestSteps(id)
    const wanted = [['strategy', 'brief-strategy', 'brief-analysis.md'], ['strategy', 'story-architect', 'script.md'], ['strategy', 'concept-pitch', 'treatment.md'], ['preproduction', 'art-director', 'art-direction.md'], ['preproduction', 'storyboard-previs', 'shots.json'], ['production', 'voice-performance', 'voice.json'], ['postproduction', 'sound-music', 'audio-mix.json'], ['delivery', 'versioning', 'versions.json'], ['delivery', 'disclosure-metadata', 'provenance.json']]
    const docs: { name: string; text: string }[] = []
    for (const [stage, agent, file] of wanted) {
      const step = latest.get(`${stage}/${agent}`)
      const text = step?.status === 'done' ? await files.read(`${stepDir(id, stage, agent, step.version)}/${file}`) : null
      if (text) docs.push({ name: file, text: text.slice(0, 12_000) })
    }
    const write = p.simulation || !opts.reporter ? plainReporter : opts.reporter
    const { markdown, costUsd, use } = await write({ project: p, brand: await brandOf(p), docs, videos: await clientVideos(id) })
    await files.write(path, markdown)
    await addCost(id, 'delivery', 'client-report', costUsd, use)
    return markdown
  }

  // ---------------------------------------------------------------- Exploración antes de producir

  // ponytail: los tableros viven en un archivo del proyecto y los cambios van en fila dentro de este proceso.
  // Con varios servidores a la vez haría falta una tabla con bloqueo.
  const EXPLORE = 'exploracion'
  const MAX_BOARDS = 8, MAX_PER_BOARD = 16
  const lines = new Map<string, Promise<unknown>>()
  const inLine = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const next = (lines.get(id) ?? Promise.resolve()).catch(() => {}).then(fn)
    lines.set(id, next)
    return next
  }
  const readExploration = async (id: string): Promise<Exploration> => JSON.parse((await files.read(`${id}/${EXPLORE}/tableros.json`)) ?? '{"idea":"","boards":[]}')
  const writeExploration = (id: string, x: Exploration) => files.write(`${id}/${EXPLORE}/tableros.json`, JSON.stringify(x))
  const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  const aspectOf = (v: unknown): Aspect => ((ASPECTS as readonly string[]).includes(v as string) ? (v as Aspect) : '16:9')
  async function exploring(id: string) {
    const p = await project(id)
    if (p.status !== 'exploring') throw new Error('Esta producción ya no está en exploración')
    if (!opts.explorer) throw new Error('La exploración no está disponible en este servidor')
    return { p, explorer: opts.explorer }
  }

  /** Lo que ve la sala de exploración: los tableros, lo que cuesta una imagen y si hay fotos reales del producto. */
  async function getExploration(id: string) {
    const [p, x, cfg] = await Promise.all([project(id), readExploration(id), getSettings()])
    const brand = await brandOf(p)
    return { ...x, usdPerImage: p.simulation ? 0 : imageModel(cfg.imageModel).usdPerImage, imageModel: imageModel(cfg.imageModel).name, productPhotos: productPhotos(brand).length }
  }
  const productPhotos = (brand: Brand | null) => (brand?.assets ?? []).filter((a) => /\/producto-\d+\.(png|jpg)$/.test(a)).slice(0, 6)

  /** Claude lee el brief y propone la idea y más tableros. Los que ya existen se conservan, tengan o no imágenes. */
  async function suggestExploration(id: string) {
    const { p, explorer } = await exploring(id)
    if (p.spent >= p.budget_cap) throw new Error('El proyecto ya alcanzó su tope de presupuesto')
    if ((await readExploration(id)).boards.length >= MAX_BOARDS) throw new Error(`Ya hay ${MAX_BOARDS} tableros. Quita alguno para pedir más propuestas.`)
    // Una respuesta que no se pudo leer también costó: el explorador la devuelve en el error para que quede registrada.
    const s = await explorer.suggest({ project: p, brand: await brandOf(p) }).catch(async (err) => {
      if (err?.costUsd > 0) await addCost(id, 'exploration', 'exploration', err.costUsd, err.use)
      throw err
    })
    await addCost(id, 'exploration', 'exploration', s.costUsd, s.use)
    return inLine(id, async () => {
      const x = await readExploration(id)
      const fresh = s.boards.slice(0, Math.max(MAX_BOARDS - x.boards.length, 0)).map((b) => ({ ...b, id: `t${randomBytes(4).toString('hex')}`, withProduct: false, images: [] }))
      const next = { idea: x.idea || s.idea, boards: [...x.boards, ...fresh] }
      await writeExploration(id, next)
      return next
    })
  }

  /** Guarda la idea y los textos de los tableros. Las imágenes de cada tablero las lleva el servidor, no el navegador. */
  async function saveExploration(id: string, input: { idea?: unknown; boards?: unknown }) {
    await exploring(id)
    return inLine(id, async () => {
      const x = await readExploration(id)
      const list = Array.isArray(input.boards) ? input.boards.slice(0, MAX_BOARDS) : null
      const boards = !list ? x.boards : list.map((b: any) => {
        const old = x.boards.find((o) => o.id === b?.id)
        return { id: old?.id ?? `t${randomBytes(4).toString('hex')}`, title: clean(b?.title, 60) || 'Tablero', prompt: clean(b?.prompt, 1500), note: clean(b?.note, 400), aspect: aspectOf(b?.aspect), withProduct: b?.withProduct === true, images: old?.images ?? [] }
      })
      const next = { idea: input.idea === undefined ? x.idea : clean(input.idea, 800), boards }
      await writeExploration(id, next)
      return next
    })
  }

  // Lo apartado por generaciones en curso, en dólares por proyecto y en imágenes por tablero: varias peticiones a la vez
  // verían el mismo saldo y entre todas pasarían el tope.
  const held = new Map<string, number>()
  const hold = (key: string, n: number) => held.set(key, (held.get(key) ?? 0) + n)

  /** Genera opciones para un tablero. Cada imagen queda con su procedencia y cuenta contra el tope del proyecto. */
  async function generateExploration(id: string, boardId: string, count = 4) {
    const { p, explorer } = await exploring(id)
    const cfg = await getSettings()
    const board = (await readExploration(id)).boards.find((b) => b.id === boardId)
    if (!board) throw new Error('Ese tablero ya no existe')
    if (board.prompt.length < 10) throw new Error('Describe con más detalle qué quieres ver en este tablero')
    if (!(Number.isInteger(count) && count >= 1 && count <= 4)) throw new Error('Se generan de 1 a 4 opciones cada vez')
    const photos = board.withProduct ? productPhotos(await brandOf(p)) : []
    const referenceUrls = await Promise.all(photos.map((a) => files.url(a)))
    const each = p.simulation ? 0 : imageModel(cfg.imageModel).usdPerImage
    // Desde aquí hasta apartar no hay esperas: la comprobación y la reserva son un solo paso.
    const left = (await project(id)).budget_cap - (await project(id)).spent
    if (board.images.length + (held.get(`${id}/${boardId}`) ?? 0) + count > MAX_PER_BOARD) throw new Error(`Un tablero admite hasta ${MAX_PER_BOARD} imágenes. Crea otro tablero para seguir explorando.`)
    if (each * count > left - (held.get(id) ?? 0) + 1e-9) throw new Error(`Falta presupuesto: generar ${count} imágenes cuesta $${(each * count).toFixed(2)} y al proyecto le quedan $${Math.max(left - (held.get(id) ?? 0), 0).toFixed(2)}. Sube el tope para seguir.`)
    hold(id, each * count); hold(`${id}/${boardId}`, count)
    try {
      const made = await Promise.allSettled(Array.from({ length: count }, () => explorer.image({ project: p, prompt: board.prompt, aspect: board.aspect, referenceUrls, model: cfg.imageModel })))
      const ok = made.flatMap((m) => (m.status === 'fulfilled' ? [m.value] : []))
      let saved = 0
      let problem: unknown = (made.find((m) => m.status === 'rejected') as PromiseRejectedResult | undefined)?.reason
      // Cada imagen se guarda, se cobra y se anota en el tablero antes de pasar a la siguiente: un fallo no deja huérfanas a las anteriores.
      const next = await inLine(id, async () => {
        for (const g of ok) {
          try {
            const file = `${EXPLORE}/${boardId}-${randomBytes(4).toString('hex')}.jpg`
            // Lo que generó el proveedor ya está cobrado, se pueda guardar o no.
            await addCost(id, 'exploration', 'exploration', g.costUsd)
            await files.writeBytes(`${id}/${file}`, g.bytes, 'image/jpeg')
            await recordAsset(id, { path: file, kind: 'image', tool: 'generate_image', provider: g.provider, model: g.model, prompt: board.prompt, seed: g.seed, inputs: photos.map((a) => `brand/${a.split('/').pop()}`), costUsd: g.costUsd, license: g.license, measurements: null })
            const x = await readExploration(id)
            const b = x.boards.find((o) => o.id === boardId)
            // Si quitaron el tablero mientras se generaba, la imagen queda en la procedencia pero no hay dónde mostrarla.
            if (b) { b.images.push({ file, selected: false }); await writeExploration(id, x); saved++ }
          } catch (err) { problem = err }
        }
        return readExploration(id)
      })
      if (!saved && problem) throw problem instanceof Error ? problem : new Error(String(problem))
      return { ...next, failed: count - saved }
    } finally {
      hold(id, -each * count); hold(`${id}/${boardId}`, -count)
    }
  }

  async function selectExploration(id: string, file: string, selected: boolean) {
    await exploring(id)
    return inLine(id, async () => {
      const x = await readExploration(id)
      const image = x.boards.flatMap((b) => b.images).find((i) => i.file === file)
      if (!image) throw new Error('Esa imagen ya no existe')
      image.selected = selected
      await writeExploration(id, x)
      return x
    })
  }

  /** Las imágenes elegidas pasan a ser referencias del proyecto, con la indicación de su tablero, y arranca la producción. */
  async function startProduction(id: string) {
    await exploring(id)
    await inLine(id, async () => {
      const before = await listReferences(id)
      const picked = (await readExploration(id)).boards.flatMap((b) => b.images.filter((i) => i.selected).map((i) => ({ file: i.file, note: `${b.title}. ${b.note}`.slice(0, 500) })))
      if (before.length + picked.length > MAX_REFERENCES) throw new Error(`Un proyecto admite ${MAX_REFERENCES} referencias y ya tiene ${before.length}: elige como máximo ${MAX_REFERENCES - before.length} imágenes.`)
      // El cambio de estado va primero: dos clics seguidos no arrancan ni copian dos veces.
      if (!(await move(id, 'exploring', 'running'))) throw new Error('Esta producción ya no está en exploración')
      try {
        for (const i of picked) {
          const bytes = await files.readBytes(`${id}/${i.file}`)
          if (bytes) await addReference(id, bytes, '.jpg', 'image/jpeg', i.note, '')
        }
      } catch (err) {
        // Se deshace lo copiado y se vuelve a la sala, salvo que entre tanto alguien haya cancelado el proyecto.
        await files.write(`${id}/referencias/notas.json`, JSON.stringify(before))
        await move(id, 'running', 'exploring')
        throw err
      }
    })
    kick(id)
  }

  /** Lo elegido en la exploración, tal como lo ve el cliente: la idea y las imágenes por tablero, cada una con un nombre estable. */
  async function moodboard(id: string) {
    const x = await readExploration(id)
    const paths: Record<string, string> = {}
    const name = (file: string) => { const n = file.split('/').pop()!.replace(/\.jpg$/, ''); paths[n] = file; return n }
    const boards = x.boards.map((b) => ({ title: b.title, note: b.note, images: b.images.filter((i) => i.selected).map((i) => name(i.file)) })).filter((b) => b.images.length)
    return { idea: x.idea, boards, paths }
  }

  // ponytail: el tipo de enlace va en el prefijo del secreto, sin columna nueva en la tabla. Pasar a una columna si aparecen más tipos.
  const MOOD = 'm-'
  /** Enlace de solo lectura al moodboard, para que el cliente apruebe el look antes de gastar en la producción. */
  async function shareMoodboard(id: string, by: string, days = 14) {
    const p = await project(id)
    if (!Object.keys((await moodboard(id)).paths).length) throw new Error('Elige al menos una imagen antes de crear el enlace para el cliente')
    const token = MOOD + randomBytes(24).toString('base64url')
    const expires = new Date(Date.now() + days * 86_400_000).toISOString()
    await db('INSERT INTO shares (token, project_id, created_by, created_at, expires_at) VALUES (?,?,?,?,?)', token, p.id, by, now(), expires)
    return { token, expiresAt: expires }
  }

  // ---------------------------------------------------------------- Mejoras tras la entrega

  const IMPROVE = 'mejoras/pendiente.json'
  /**
   * Una persona pide una mejora al auditor de una etapa con la pieza ya entregada. El pedido queda guardado y el
   * recorrido lo atiende al arrancar: así sobrevive a un reinicio del servidor. El tope sube en lo que se autorice gastar.
   */
  async function requestImprovement(id: string, stageId: string, text: string, extraBudget: number, by: string) {
    const p = await project(id)
    if (!schemes[p.scheme].stages.some((s) => s.id === stageId)) throw new Error('Esa etapa no existe')
    if (text.trim().length < 10) throw new Error('Describe la mejora con más detalle')
    if (!(extraBudget > 0 && extraBudget <= 10_000)) throw new Error('Indica cuánto se puede gastar en esta mejora, entre 1 y 10 000 dólares')
    if (p.status !== 'done') throw new Error('Las mejoras se piden sobre una producción ya entregada')
    // Primero queda escrito el pedido y subido el tope; el cambio de estado va al final y, si no entra, se deshace todo.
    await files.write(`${id}/${IMPROVE}`, JSON.stringify({ stage: stageId, text: text.trim(), by, at: now() }))
    await db('UPDATE projects SET budget_cap = budget_cap + ? WHERE id = ?', extraBudget, id)
    if (!(await move(id, 'done', 'running'))) {
      await db('UPDATE projects SET budget_cap = budget_cap - ? WHERE id = ?', extraBudget, id)
      await files.write(`${id}/${IMPROVE}`, '{}')
      throw new Error('Las mejoras se piden sobre una producción ya entregada')
    }
    await emit(id, 'improvement.requested', { stage: stageId, text: text.trim(), budget: extraBudget, by })
    kick(id)
  }

  /** El auditor de la etapa reparte la mejora entre sus agentes; lo que venga después se actualiza y vuelve a pasar por auditoría y aprobación. */
  async function planImprovement(id: string, scheme: Scheme) {
    const raw = await files.read(`${id}/${IMPROVE}`)
    const req = raw ? JSON.parse(raw) : null
    if (!req?.text) return
    const stage = scheme.stages.find((s) => s.id === req.stage)
    const p = await project(id)
    if (p.status !== 'running') return
    if (stage) {
      const { verdict, auditor } = await askAuditor(p, scheme, stage, await latestSteps(id), { request: req.text })
      // Sin reparto (en simulación, o si el auditor no señaló a nadie), la mejora va a toda la etapa.
      const known = verdict.issues.filter((i) => stage.agents.some((a) => a.id === i.agent))
      const issues = known.length ? known : stage.agents.map((a) => ({ agent: a.id, problem: req.text as string }))
      const name = (agent: string) => stage.agents.find((a) => a.id === agent)!.name
      // No es un rechazo: el auditor cierra su parte y el trabajo vuelve a sus agentes.
      await emit(id, 'audit.verdict', { stage: stage.id, auditor, approved: true, issues: [], attempt: 1, improvement: true })
      await emit(id, 'improvement.planned', { stage: stage.id, issues })
      await returnWork(id, scheme, scheme.stages.at(-1)!, [...new Set(issues.map((i) => i.agent))],
        `Mejora pedida por la persona sobre la pieza ya entregada: ${req.text}\nReparto del ${stage.auditor.name}:\n${issues.map((i) => `- ${name(i.agent)}: ${i.problem}`).join('\n')}\nSi tu nombre aparece en el reparto, haz lo que te toca; lo demás de tu entrega se conserva.`)
    }
    await files.write(`${id}/${IMPROVE}`, '{}')
  }

  // ---------------------------------------------------------------- Opinión del cliente

  const FEEDBACK = 'client/comentarios.json'
  type ClientNote = { id: string; at: string; kind: 'approve' | 'comment'; about: 'moodboard' | 'pieza'; target: string; name: string; text: string; status: 'new' | 'used' | 'dismissed' }
  const listClientFeedback = async (id: string): Promise<ClientNote[]> => JSON.parse((await files.read(`${id}/${FEEDBACK}`)) || '[]')

  /** Lo que el cliente aprueba o comenta desde su enlace. Queda pendiente: una persona del estudio decide qué hacer con ello. */
  async function addClientFeedback(token: string, input: { kind?: unknown; target?: unknown; text?: unknown; name?: unknown }) {
    const share = await openShare(token)
    if (!share) return null
    const kind = input.kind === 'approve' ? 'approve' : 'comment'
    const text = clean(input.text, 1000)
    if (kind === 'comment' && text.length < 3) throw new Error('Escribe tu comentario antes de enviarlo')
    const note: ClientNote = { id: randomBytes(6).toString('hex'), at: now(), kind, about: token.startsWith(MOOD) ? 'moodboard' : 'pieza', target: clean(input.target, 80), name: clean(input.name, 60), text, status: 'new' }
    await inLine(share.projectId, async () => {
      const list = await listClientFeedback(share.projectId)
      // Un enlace público no puede llenar el almacenamiento.
      if (list.length >= 200) throw new Error('Esta producción ya tiene muchos comentarios. Escríbele directamente a tu contacto en Pana Films.')
      await files.write(`${share.projectId}/${FEEDBACK}`, JSON.stringify([...list, note]))
    })
    await emit(share.projectId, 'client.feedback', { id: note.id, kind, about: note.about, target: note.target, name: note.name, text })
    return { ok: true }
  }

  async function resolveClientFeedback(id: string, noteId: string, status: unknown) {
    if (status !== 'used' && status !== 'dismissed') throw new Error('Un comentario se marca como usado o como descartado')
    return inLine(id, async () => {
      const list = await listClientFeedback(id)
      const note = list.find((n) => n.id === noteId)
      if (!note) throw new Error('Ese comentario ya no existe')
      note.status = status
      await files.write(`${id}/${FEEDBACK}`, JSON.stringify(list))
      return list
    })
  }

  /** Enlace de solo lectura para un cliente. El secreto va en el enlace; no hay otra forma de llegar a la vista previa. */
  async function createShare(id: string, by: string, days = 14) {
    const p = await project(id)
    if (!(days >= 1 && days <= 90)) throw new Error('El enlace puede durar entre 1 y 90 días')
    if (!(await clientVideos(id)).length) throw new Error('Esta producción todavía no tiene una pieza montada que enseñar')
    await clientReport(id)
    const token = randomBytes(24).toString('base64url')
    const expires = new Date(Date.now() + days * 86_400_000).toISOString()
    await db('INSERT INTO shares (token, project_id, created_by, created_at, expires_at) VALUES (?,?,?,?,?)', token, p.id, by, now(), expires)
    return { token, expiresAt: expires }
  }

  const listShares = async (id: string) => (await db('SELECT token, created_by, created_at, expires_at, revoked_at, views FROM shares WHERE project_id = ? ORDER BY created_at DESC', id))
    .map((r) => ({ token: r.token, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at, views: r.views, active: !r.revoked_at && r.expires_at > now() }))

  async function revokeShare(id: string, token: string) {
    const gone = await db('UPDATE shares SET revoked_at = ? WHERE token = ? AND project_id = ? AND revoked_at IS NULL RETURNING token', now(), token, id)
    if (!gone.length) throw new Error('Ese enlace no existe o ya estaba revocado')
  }

  /** Lo que ve el cliente. Un enlace vencido, revocado o inventado no revela ni que el proyecto existe. */
  async function openShare(token: string, count = false) {
    if (!/^[\w-]{20,64}$/.test(token)) return null
    const [share] = await db('SELECT project_id, expires_at FROM shares WHERE token = ? AND revoked_at IS NULL AND expires_at > ?', token, now())
    if (!share) return null
    if (count) await db('UPDATE shares SET views = views + 1 WHERE token = ?', token)
    const p = await project(share.project_id)
    const head = { projectId: p.id, name: p.name, brand: p.brand, expiresAt: share.expires_at as string }
    // Un enlace de moodboard enseña solo el look, aunque la pieza ya exista: no revela un corte sin aprobar ni escribe la memoria.
    if (token.startsWith(MOOD)) return { ...head, report: '', videos: [] as Awaited<ReturnType<typeof clientVideos>>, moodboard: await moodboard(p.id) }
    return { ...head, report: await clientReport(p.id), videos: await clientVideos(p.id), moodboard: { idea: '', boards: [], paths: {} as Record<string, string> } }
  }

  /** Lo que recibiría el auditor de una etapa, sin ejecutarlo. Lo usa la regresión con defectos sembrados. */
  async function auditCase(id: string, stageId: string) {
    const p = await project(id), scheme = schemes[p.scheme], stage = scheme.stages.find((s) => s.id === stageId)
    if (!stage) throw new Error('Esa etapa no existe')
    return { project: p, stage, brand: await brandOf(p), deliverables: inputsFor(id, await latestSteps(id), scheme, stage).filter((i) => i.stage === stage.id), assets: () => listAssets(id) }
  }

  return { auditCase, advance, resumeAll, createProject, getProject, listProjects, listBrands, brandByName, addBrandAsset, listReferences, addReference, getExploration, suggestExploration, saveExploration, generateExploration, selectExploration, startProduction, shareMoodboard, requestImprovement, addClientFeedback, listClientFeedback, resolveClientFeedback, listAssets, overview, costReport, deleteProject, clientReport, createShare, listShares, revokeShare, openShare, decide, pause, resume, setBudget, cancel, rerun, restore, getSettings, setSettings, eventsAfter, files, schemes }
}

export type Engine = ReturnType<typeof createEngine>
