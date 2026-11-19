import type { Usage } from './models.ts'
import { createHash } from 'node:crypto'

/** Familias de herramientas de generación y montaje que un agente puede usar. Ver y medir archivos lo pueden hacer todos. */
export type ToolFamily = 'image' | 'video' | 'voice' | 'music' | 'sfx' | 'cut' | 'grade' | 'mix' | 'titles' | 'master' | 'versions' | 'provenance'
export type AgentDef = { id: string; name: string; deliverables: string[]; tools?: ToolFamily[] }
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
  /** Modo con el que se creó. No cambia aunque después se mueva el interruptor del panel. */
  simulation: boolean

  brand: string | null
}

/** Consulta SQL con marcadores `?`. Devuelve las filas. */
export type Db = (sql: string, ...params: unknown[]) => Promise<any[]>

/**
 * Archivos por ruta, guardados en Supabase Storage.
 * Entregables: `<proyecto>/<etapa>/<agente>/v<n>/<archivo>`. Biblioteca de marca: `brands/<marca>/<archivo>`.
 */
export type Files = {
  read(path: string): Promise<string | null>
  write(path: string, content: string): Promise<void>
  readBytes(path: string): Promise<Uint8Array | null>
  writeBytes(path: string, bytes: Uint8Array, contentType: string): Promise<void>
  /** Nombres de los archivos de una carpeta, sin subcarpetas. */
  list(dir: string): Promise<string[]>
  copy(from: string, to: string): Promise<void>
  /** Dirección temporal para que un proveedor de generación descargue el archivo. */
  url(path: string): Promise<string>
  removeDir(prefix: string): Promise<void>
}

/** `assets` son los archivos reales del cliente (logo, fotos de producto), con su ruta completa en Storage. */
export type Brand = { name: string; kit: string; assets: string[] }

/**
 * Carpeta de una marca en Storage. La parte legible sale del nombre y el sufijo de su huella exacta,
 * para que dos clientes de nombre parecido ("Café" y "Cafe", "A&B" y "A B") nunca compartan archivos.
 */
/** Foto de referencia que una persona sube al revisar una etapa, con la indicación que la acompaña. */
export type Reference = { file: string; note: string; stage: string }
export const readReferences = async (files: Files, projectId: string): Promise<Reference[]> => JSON.parse((await files.read(`${projectId}/referencias/notas.json`)) ?? '[]')

export const brandDir = (name: string) => {
  const slug = name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'marca'
  return `brands/${slug}-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`
}

export type Measurements = { durationSeconds: number | null; width: number | null; height: number | null; fps: number | null; hasAudio: boolean; lufs: number | null }

/** Registro de procedencia de un archivo generado o montado. `path` es relativa al proyecto. */
export type Asset = {
  path: string
  kind: 'image' | 'video' | 'audio'
  tool: string
  provider: string
  model: string
  prompt: string | null
  seed: string | null
  /** Archivos de los que se derivó, con ruta relativa al proyecto. */
  inputs: string[]
  costUsd: number
  license: string
  measurements: Measurements | null
  createdAt: string
}
export type NewAsset = Omit<Asset, 'createdAt'>

/** `dir` es el prefijo de ruta de la versión vigente de ese agente. */
export type Input = { stage: string; agent: string; dir: string }

export type AgentRun = {
  project: Project
  /** Modelo de Claude elegido para este agente en la configuración. Sin él, el de por defecto. */
  model?: string
  /** Tiempo máximo de la ejecución, de la configuración. */
  timeoutMs?: number
  /** Modelos de imagen y de video final elegidos en la configuración. */
  media?: { image?: string; video?: string }
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
  /** Registra al instante el costo de una herramienta de pago, para que no se pierda si el agente falla después. */
  spend(usd: number, use?: Usage): Promise<void>
  record(asset: NewAsset): Promise<void>
  assets(): Promise<Asset[]>
  /** Se activa cuando una persona cancela el proyecto: el agente debe dejar de trabajar y de gastar. */
  signal: AbortSignal
}

export type AuditRun = {
  project: Project
  model?: string
  timeoutMs?: number
  stage: StageDef
  deliverables: Input[]
  files: Files
  brand: Brand | null
  say: (text: string) => void
  assets(): Promise<Asset[]>
  spend(usd: number, use?: Usage): Promise<void>
  signal: AbortSignal
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
