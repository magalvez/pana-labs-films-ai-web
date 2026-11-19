import { join } from 'node:path'
import type { Engine } from './engine/pipeline.ts'
import type { Files, Runner } from './engine/types.ts'

// Regresión de auditores con defectos sembrados: se toma una producción ya hecha, se le planta un defecto evidente
// en un entregable de cada etapa y se comprueba que el auditor de esa etapa lo rechaza y señala al agente correcto.
// El defecto vive solo en memoria: la producción real no se toca, ni sus archivos, ni su gasto, ni sus eventos.
// Con el auditor real cuesta dinero (una auditoría por etapa). `maxUsd` corta las revisiones de medios de cada una
// cuando lo gastado llega a esa cifra; los tokens del propio auditor no tienen tope y pueden pasarla.

/** Contradice el brief en duración y en marca: cualquier auditor que lea el entregable debe rechazarlo. */
export const DEFECT = '\n\n## Cambio de última hora\nPor decisión interna, la pieza final durará 4 minutos en vez de lo que pide el brief, y cerrará con el logotipo y el eslogan de la marca competidora en lugar de los del cliente.\n'

export type SeededResult = { stage: string; agent: string; file: string; caught: boolean; blamed: boolean; usd: number; problems: string[]; error?: string }

/** Archivos de la producción con un entregable alterado en memoria. Lo que el auditor escriba tampoco llega al almacenamiento. */
function overlay(files: Files, path: string, content: string): Files {
  const mem = new Map<string, Uint8Array>([[path, new TextEncoder().encode(content)]])
  return {
    ...files,
    readBytes: async (p) => mem.get(p) ?? files.readBytes(p),
    read: async (p) => (mem.has(p) ? new TextDecoder().decode(mem.get(p)) : files.read(p)),
    writeBytes: async (p, bytes) => void mem.set(p, bytes),
    write: async (p, text) => void mem.set(p, new TextEncoder().encode(text)),
    copy: async (from, to) => { const b = mem.get(from) ?? (await files.readBytes(from)); if (b) mem.set(to, b) },
    removeDir: async () => {},
  }
}

export async function seededAudit(o: { engine: Engine; runner: Runner; projectId: string; stages?: string[]; maxUsd?: number; model?: (auditor: string) => string | undefined; log?: (line: string) => void }): Promise<SeededResult[]> {
  const { engine, runner, projectId, maxUsd = 2, log = () => {} } = o
  const p = await engine.getProject(projectId)
  const out: SeededResult[] = []
  const all = engine.schemes[p.scheme].stages
  // Una etapa mal escrita no puede acabar en una regresión vacía que pasa.
  const unknown = (o.stages ?? []).filter((id) => !all.some((s) => s.id === id))
  if (unknown.length) throw new Error(`Etapa desconocida: ${unknown.join(', ')}. Las etapas son: ${all.map((s) => s.id).join(', ')}`)
  for (const s of all) {
    if (o.stages?.length && !o.stages.includes(s.id)) continue
    const c = await engine.auditCase(projectId, s.id)
    // El defecto va en el primer documento de texto que la etapa realmente entregó.
    const input = c.deliverables.find((d) => c.stage.agents.find((a) => a.id === d.agent)?.deliverables.some((f) => f.endsWith('.md')))
    const agent = c.stage.agents.find((a) => a.id === input?.agent)
    const file = agent?.deliverables.find((f) => f.endsWith('.md'))
    const original = input && file ? await engine.files.read(`${input.dir}/${file}`) : null
    if (!input || !agent || !file || original === null) { out.push({ stage: s.id, agent: agent?.id ?? '', file: file ?? '', caught: false, blamed: false, usd: 0, problems: [], error: 'La etapa no tiene un documento de texto entregado donde sembrar el defecto' }); continue }
    let usd = 0
    const result: SeededResult = { stage: s.id, agent: agent.id, file, caught: false, blamed: false, usd: 0, problems: [] }
    log(`${s.name}: defecto sembrado en ${file} de ${agent.name}…`)
    try {
      const verdict = await runner.runAuditor({
        // El auditor ve el tope real de la producción, igual que cuando la auditó de verdad: un tope inventado le haría
        // rechazar por presupuesto y parecería que vio el defecto. Solo se sube si ya no queda margen para revisar medios.
        project: { ...c.project, budget_cap: Math.max(c.project.budget_cap, c.project.spent + maxUsd) }, stage: c.stage, deliverables: c.deliverables, brand: c.brand, assets: c.assets,
        files: overlay(engine.files, `${input.dir}/${file}`, original + DEFECT),
        // El límite va como tiempo de la ejecución, no como cancelación: así el error dice que se agotó el tiempo y no que el proyecto se canceló.
        model: o.model?.(c.stage.auditor.id), timeoutMs: 30 * 60_000, say: () => {}, spend: async (n) => { usd += n }, signal: new AbortController().signal,
      })
      result.caught = !verdict.approved
      result.blamed = verdict.issues.some((i) => i.agent === agent.id)
      result.problems = verdict.issues.map((i) => `${i.agent}: ${i.problem}`)
      usd += verdict.costUsd
    } catch (err) { result.error = err instanceof Error ? err.message : String(err) }
    result.usd = usd
    out.push(result)
  }
  return out
}

// Uso: npm run regression:auditors -- <id de producción> [etapa,etapa] [tope de revisión de medios por auditoría, en dólares]
if (import.meta.main) {
  const [projectId, stages, cap] = process.argv.slice(2)
  if (!projectId) { console.error('Indica la producción: npm run regression:auditors -- <id de producción> [etapas separadas por coma] [tope por auditoría]\nEl id se ve en la dirección del estudio o en Producciones. Usa una producción real ya entregada.'); process.exit(1) }
  const { createClient } = await import('@supabase/supabase-js')
  const { createEngine } = await import('./engine/pipeline.ts')
  const { claudeRunner } = await import('./engine/claudeRunner.ts')
  const { supabaseFiles } = await import('./files.ts')
  const { supabaseDb } = await import('./store.ts')
  const { commercial } = await import('./schemes/commercial.ts')
  const env = process.env as Record<string, string>
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const runner = claudeRunner({ agentsDir: join(import.meta.dirname, 'agents') })
  const engine = createEngine({ db: supabaseDb(env.DATABASE_URL), files: supabaseFiles(supabase), schemes: { commercial }, runner })
  const settings = await engine.getSettings()
  console.log('Regresión de auditores con defectos sembrados. Usa los auditores reales: cuesta dinero.\n')
  const results = await seededAudit({ engine, runner, projectId, stages: stages?.split(',').filter(Boolean), maxUsd: Number(cap) || 2, model: (id) => settings.models[id], log: (l) => console.log(l) })
  console.log('')
  for (const r of results) console.log(`${r.error ? 'ERROR   ' : r.caught && r.blamed ? 'DETECTADO' : r.caught ? 'A MEDIAS ' : 'NO VISTO '} ${r.stage.padEnd(16)} $${r.usd.toFixed(2)}  ${r.error ?? (r.caught ? (r.blamed ? 'rechazó y señaló al agente correcto' : 'rechazó, pero no señaló al agente del defecto') : 'aprobó la etapa con el defecto dentro')}`)
  const ok = results.filter((r) => r.caught && r.blamed).length
  console.log(`\n${ok} de ${results.length} auditores detectaron el defecto. Costo total: $${results.reduce((n, r) => n + r.usd, 0).toFixed(2)}. La producción no se modificó.`)
  process.exit(ok === results.length ? 0 : 1)
}
