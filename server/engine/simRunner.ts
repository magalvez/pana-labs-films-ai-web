import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Runner } from './types.ts'

/** Agentes enlatados: escriben entregables de muestra sin llamar a ningún proveedor. */
export function simRunner(opts: { delayMs?: number; rejectOnce?: string[] } = {}): Runner {
  const delayMs = opts.delayMs ?? 0
  const rejected = new Set<string>()
  return {
    async runAgent({ project, stage, agent, version, outDir, inputs, feedback, to, say }) {
      say(feedback ? `Corrigiendo: ${feedback}` : `Leyendo ${inputs.length} entregables previos`)
      await sleep(delayMs)
      for (const file of agent.deliverables) {
        const body = file.endsWith('.json')
          ? JSON.stringify({ simulated: true, project: project.name, agent: agent.id, version }, null, 2)
          : `Simulación de ${file}\nProyecto: ${project.name}\nAgente: ${agent.name}\nVersión: ${version}\n`
        writeFileSync(join(outDir, file), body)
        say(`Escribí ${file}`)
        await sleep(delayMs / 2)
      }
      const handoff = { agent: agent.id, stage: stage.id, version, to, summary: `${agent.name} entregó ${agent.deliverables.join(', ')}`, files: agent.deliverables }
      writeFileSync(join(outDir, 'handoff.json'), JSON.stringify(handoff, null, 2))
      return { costUsd: 0 }
    },
    async runAuditor({ project, stage, deliverables, say }) {
      say(`Revisando ${deliverables.length} entregas contra la rúbrica`)
      await sleep(delayMs)
      const key = `${project.id}/${stage.id}`
      if (opts.rejectOnce?.includes(stage.id) && !rejected.has(key)) {
        rejected.add(key)
        return { approved: false, costUsd: 0, issues: [{ agent: stage.agents[0].id, problem: 'Simulación: el entregable no respeta la Story Bible' }] }
      }
      return { approved: true, issues: [], costUsd: 0 }
    },
  }
}
