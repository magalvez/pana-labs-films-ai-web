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
}

export type Input = { stage: string; agent: string; dir: string }

export type AgentRun = {
  project: Project
  stage: StageDef
  agent: AgentDef
  version: number
  /** Carpeta vacía donde el agente escribe sus entregables y handoff.json. */
  outDir: string
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
  say: (text: string) => void
}

export type Verdict = {
  approved: boolean
  issues: { agent: string; problem: string }[]
  costUsd: number
}

export type Runner = {
  runAgent(run: AgentRun): Promise<{ costUsd: number }>
  runAuditor(run: AuditRun): Promise<Verdict>
}

export type Ev = { id: number; projectId: string; ts: string; type: string; data: any }
