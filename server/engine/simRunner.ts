import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { sample } from '../media/ffmpeg.ts'
import { CONTENT_TYPES, kindOf } from './tools.ts'
import type { Asset, Runner, ToolFamily } from './types.ts'

const EXT = { image: '.jpg', video: '.mp4', audio: '.mp3' } as const
/** Lo que un agente con herramientas produce además de sus entregables fijos, para que la simulación se parezca a la real. */
const EXTRAS: Partial<Record<ToolFamily, string>> = { image: 'muestra.jpg', video: 'muestra.mp4', voice: 'muestra-voz.mp3', music: 'muestra-musica.mp3', versions: 'muestra-9x16.mp4' }

const cache = new Map<Asset['kind'], Promise<Uint8Array>>()
/** Archivos de muestra hechos con ffmpeg en el servidor, una vez por proceso. No llaman a ningún proveedor. */
function sampleMedia(kind: Asset['kind']): Promise<Uint8Array> {
  let bytes = cache.get(kind)
  if (!bytes) {
    bytes = (async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pana-sim-'))
      try {
        const file = join(dir, `muestra${EXT[kind]}`)
        await sample(kind, file)
        return new Uint8Array(await readFile(file))
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })()
    cache.set(kind, bytes)
    // Un fallo (ffmpeg sin instalar) no se queda guardado: el siguiente intento vuelve a probar.
    bytes.catch(() => cache.delete(kind))
  }
  return bytes
}

/** Agentes enlatados: escriben entregables de muestra sin llamar a ningún proveedor. */
export function simRunner(opts: { delayMs?: number; rejectOnce?: string[]; media?: (kind: Asset['kind']) => Promise<Uint8Array> } = {}): Runner {
  const delayMs = opts.delayMs ?? 0
  const media = opts.media ?? sampleMedia
  const rejected = new Set<string>()
  return {
    async runAgent({ project, stage, agent, version, dir, files, inputs, feedback, to, say, record }) {
      say(feedback ? `Corrigiendo: ${feedback}` : `Leyendo ${inputs.length} entregables previos`)
      await sleep(delayMs)
      const extras = (agent.tools ?? []).flatMap((f) => EXTRAS[f] ?? [])
      const names = [...agent.deliverables, ...extras]
      for (const file of names) {
        const kind = kindOf(file)
        if (kind) {
          await files.writeBytes(`${dir}/${file}`, await media(kind), CONTENT_TYPES[EXT[kind]])
          await record({ path: `${dir.slice(project.id.length + 1)}/${file}`, kind, tool: 'simulación', provider: 'servidor', model: 'simulación', prompt: null, seed: null, inputs: [], costUsd: 0, license: 'Archivo de muestra, sin valor de entrega.', measurements: null })
        } else {
          const body = file.endsWith('.json')
            ? JSON.stringify({ simulated: true, project: project.name, agent: agent.id, version }, null, 2)
            : `Simulación de ${file}\nProyecto: ${project.name}\nAgente: ${agent.name}\nVersión: ${version}\n`
          await files.write(`${dir}/${file}`, body)
        }
        say(`Escribí ${file}`)
        await sleep(delayMs / 2)
      }
      const handoff = { agent: agent.id, stage: stage.id, version, to, summary: `${agent.name} entregó ${names.join(', ')}`, files: names }
      await files.write(`${dir}/handoff.json`, JSON.stringify(handoff, null, 2))
      return { costUsd: 0, model: 'simulación' }
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
