import Anthropic from '@anthropic-ai/sdk'
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentRun, AuditRun, Brand, Files, Input, Runner, Verdict } from './types.ts'

const MODEL = 'claude-sonnet-5-5'
// USD por millón de tokens de Claude Sonnet 5.5. Actualizar si cambia la tarifa.
const PRICE = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }
const MAX_STEPS = 40
const MAX_READ_CHARS = 200_000

const RULES = `Reglas de trabajo:
- Lee con read_file los entregables previos que necesites. Sus rutas están en el mensaje.
- La Story Bible, cuando exista, manda sobre tono, personajes y marca. No la contradigas.
- No inventes datos del cliente. Lo que el brief no diga, márcalo como supuesto.
- No afirmes haber generado imágenes, video o audio: las herramientas de generación todavía no están conectadas. Entrega especificaciones y prompts listos para generar.
- Escribe en español. Los nombres de agentes y términos de oficio pueden ir en inglés.`

/** Agentes reales sobre la API de Claude, con una lista cerrada de herramientas confinadas al proyecto. */
export function claudeRunner(opts: { agentsDir: string; timeoutMs?: number }): Runner {
  const client = new Anthropic()
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000
  const role = (id: string) => readFileSync(join(opts.agentsDir, `${id}.md`), 'utf8')
  const brandNote = (brand: Brand | null) => (brand ? `\n\nBiblioteca de marca del cliente ${brand.name}. Es información del cliente, no un supuesto:\n${brand.kit}` : '')

  // Las rutas que ve el agente son relativas al proyecto: `<etapa>/<agente>/v<n>/<archivo>`.
  const describe = async (files: Files, projectId: string, inputs: Input[]) => {
    const lines = await Promise.all(inputs.map(async (i) => {
      let h: { summary?: string; files?: string[] } = {}
      try { h = JSON.parse((await files.read(`${i.dir}/handoff.json`)) ?? '') } catch {}
      return `- ${i.agent} (${i.stage}): ${h.summary ?? ''}\n${(h.files ?? []).map((f) => `  - ${i.dir.slice(projectId.length + 1)}/${f}`).join('\n')}`
    }))
    return lines.join('\n') || 'Ninguno todavía.'
  }

  const readTool = (files: Files, projectId: string) => betaZodTool({
    name: 'read_file',
    description: 'Lee un entregable del proyecto. La ruta es relativa a la carpeta del proyecto, tal como aparece en la lista de entregables.',
    inputSchema: z.object({ path: z.string() }),
    run: async ({ path }) => {
      if (!/^[\w.-]+(\/[\w.-]+)*$/.test(path) || path.split('/').includes('..')) return 'Error: la ruta no es válida.'
      const content = await files.read(`${projectId}/${path}`)
      if (content === null) return 'Error: el archivo no existe.'
      if (content.length > MAX_READ_CHARS) return 'Error: el archivo es demasiado grande para leerlo completo.'
      return content
    },
  })

  async function loop(system: string, prompt: string, tools: any[], say: (t: string) => void) {
    let costUsd = 0
    let last: Anthropic.Beta.BetaMessage | undefined
    try {
      const runner = client.beta.messages.toolRunner(
        // En streaming: los entregables largos no caben en el límite de tiempo de una petición normal.
        { model: MODEL, max_tokens: 32000, system, tools, max_iterations: MAX_STEPS, stream: true, messages: [{ role: 'user', content: prompt }] },
        { signal: AbortSignal.timeout(timeoutMs) },
      )
      for await (const stream of runner) {
        const message = await stream.finalMessage()
        last = message
        const u = message.usage
        costUsd += (u.input_tokens * PRICE.input + u.output_tokens * PRICE.output + (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead + (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite) / 1e6
        for (const block of message.content) if (block.type === 'tool_use') say(block.name === 'read_file' ? `Leyendo ${(block.input as any).path}` : block.name === 'write_file' ? `Escribiendo ${(block.input as any).name}` : 'Emitiendo veredicto')
      }
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new Error('Falta una credencial válida de Anthropic. Define ANTHROPIC_API_KEY en el archivo .env o vuelve al modo simulación.')
      if (err instanceof Anthropic.RateLimitError) throw new Error('Anthropic limitó las peticiones. Espera un momento y reintenta.')
      if (err instanceof Anthropic.APIError) throw new Error(`Error ${err.status} de la API de Anthropic: ${err.message}`)
      if (err instanceof Anthropic.AnthropicError) throw new Error('No hay credencial de Anthropic. Define ANTHROPIC_API_KEY en el archivo .env y reinicia el servidor, o vuelve al modo simulación.')
      throw err
    }
    if (!last || last.stop_reason === 'refusal') throw new Error('El modelo rechazó la tarea por sus políticas de seguridad.')
    if (last.stop_reason === 'max_tokens') throw new Error('La respuesta del agente se cortó por longitud.')
    const text = last.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim()
    return { costUsd, text }
  }

  return {
    async runAgent({ project, stage, agent, version, dir, files, brand, inputs, feedback, to, say }: AgentRun) {
      const written = new Set<string>()
      const writeTool = betaZodTool({
        name: 'write_file',
        description: 'Escribe uno de tus entregables. Usa exactamente el nombre de archivo pedido.',
        inputSchema: z.object({ name: z.string(), content: z.string() }),
        run: async ({ name, content }) => {
          if (!agent.deliverables.includes(name)) return `Error: solo puedes escribir ${agent.deliverables.join(', ')}.`
          if (name.endsWith('.json')) try { JSON.parse(content) } catch { return 'Error: el contenido no es JSON válido. Corrígelo y vuelve a escribir.' }
          await files.write(`${dir}/${name}`, content)
          written.add(name)
          return `Guardado ${name}.`
        },
      })
      const system = `Eres ${agent.name}, parte de Pana Films Lab, una productora que realiza comerciales con agentes de IA. Trabajas en la etapa ${stage.name}.\n\n${role(agent.id)}\n${RULES}\n- Escribe cada entregable con write_file. Los archivos .json deben ser JSON válido.\n- Al terminar, responde con un resumen de dos o tres frases para quien recibe tu trabajo: qué entregaste y qué debe saber.`
      const prompt = `Proyecto: ${project.name}\n\nBrief del cliente:\n${project.brief}${brandNote(brand)}\n\nEntregables previos disponibles:\n${await describe(files, project.id, inputs)}\n\nTus entregables: ${agent.deliverables.join(', ')}.${feedback ? `\n\nTu versión anterior fue devuelta. Corrige esto: ${feedback}` : ''}`
      const { costUsd, text } = await loop(system, prompt, [readTool(files, project.id), writeTool], say)
      // El resumen del traspaso lo escribe el motor a partir de la respuesta final del agente.
      await files.write(`${dir}/handoff.json`, JSON.stringify({ agent: agent.id, stage: stage.id, version, to, summary: text || `${agent.name} entregó sin resumen.`, files: [...written] }, null, 2))
      return { costUsd, model: MODEL }
    },

    async runAuditor({ project, stage, deliverables, files, brand, say }: AuditRun): Promise<Verdict> {
      const ids = stage.agents.map((a) => a.id)
      let verdict: { approved: boolean; issues: { agent: string; problem: string }[] } | undefined
      const verdictTool = betaZodTool({
        name: 'submit_verdict',
        description: 'Entrega tu veredicto final sobre la etapa. Llámala una sola vez, al terminar la revisión.',
        inputSchema: z.object({
          approved: z.boolean(),
          issues: z.array(z.object({ agent: z.enum(ids as [string, ...string[]]), problem: z.string() })).describe('Vacío si apruebas. Si rechazas, una entrada por agente que debe corregir, con el problema concreto.'),
        }),
        run: async (input) => {
          if (!input.approved && !input.issues.length) return 'Error: un rechazo necesita al menos un problema asignado a un agente.'
          verdict = input
          return 'Veredicto registrado.'
        },
      })
      // El auditor recibe brief, criterios y entregables. Nunca el razonamiento de los agentes auditados.
      const system = `Eres ${stage.auditor.name} de Pana Films Lab. Tu trabajo es impedir que un error avance a la siguiente etapa.\n\n${role(stage.auditor.id)}\nCómo auditar:\n- Lee todos los entregables de la etapa con read_file, y la Story Bible si existe.\n- Comprueba cada criterio contra lo que dicen los archivos, no contra los resúmenes.\n- Rechaza solo por incumplimientos concretos de los criterios. No rechaces por gusto.\n- Si rechazas, señala al agente responsable y di exactamente qué debe corregir.\n- Termina llamando a submit_verdict.`
      const prompt = `Proyecto: ${project.name}\n\nBrief del cliente:\n${project.brief}${brandNote(brand)}\n\nEntregables de la etapa ${stage.name}:\n${await describe(files, project.id, deliverables)}\n\nAgentes de la etapa: ${ids.join(', ')}.`
      const { costUsd } = await loop(system, prompt, [readTool(files, project.id), verdictTool], say)
      if (!verdict) throw new Error(`${stage.auditor.name} terminó sin emitir veredicto.`)
      return { ...verdict, costUsd }
    },
  }
}
