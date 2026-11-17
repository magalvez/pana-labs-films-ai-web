export type AgentDef = { id: string; name: string; deliverables: string[] }
export type StageDef = {
  id: string
  name: string
  /** Lo que aprueba la persona en el gate de esta etapa. */
  gate: string
  auditor: { id: string; name: string }
  /** En orden de ejecución: cada agente recibe los entregables de los anteriores. */
  agents: AgentDef[]
}
export type Scheme = { id: string; name: string; stages: StageDef[] }

export type Project = {
  id: string
  name: string
  brief: string
  scheme: string
  status: 'running' | 'paused' | 'waiting_human' | 'done' | 'failed' | 'cancelled'
  reason: string | null
  budget_cap: number
  spent: number
  created_at: string

  brand: string | null
}

/** Consulta SQL con marcadores `?`. Devuelve las filas. */
export type Db = (sql: string, ...params: unknown[]) => Promise<any[]>

/** Entregables por ruta relativa: `<proyecto>/<etapa>/<agente>/v<n>/<archivo>`, guardados en Supabase Storage. */
export type Files = {
  read(path: string): Promise<string | null>
  write(path: string, content: string): Promise<void>
  removeDir(prefix: string): Promise<void>
}

export type Brand = { name: string; kit: string }

/** `dir` es el prefijo de ruta de la versión vigente de ese agente. */
export type Input = { stage: string; agent: string; dir: string }

export type AgentRun = {
  project: Project
  stage: StageDef
  agent: AgentDef
  version: number
  /** Prefijo vacío donde el agente escribe sus entregables y handoff.json. */
  dir: string
  files: Files
  brand: Brand | null
  inputs: Input[]
  /** Observación del auditor o de la persona cuando es un reintento. */
  feedback: string | null
  /** Id del destinatario del traspaso: siguiente agente o auditor. */
  to: string
  say: (text: string) => void
}

export type AuditRun = {
  project: Project
  stage: StageDef
  deliverables: Input[]
  files: Files
  brand: Brand | null
  say: (text: string) => void
}

export type Verdict = {
  approved: boolean
  issues: { agent: string; problem: string }[]
  costUsd: number
}

export type Runner = {
  runAgent(run: AgentRun): Promise<{ costUsd: number; model: string }>
  runAuditor(run: AuditRun): Promise<Verdict>
}

export type Ev = { id: number; projectId: string; ts: string; type: string; data: any }
