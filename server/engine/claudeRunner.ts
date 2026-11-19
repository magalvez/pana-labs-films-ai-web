import Anthropic from '@anthropic-ai/sdk'
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { priceList } from '../media/prices.ts'
import { announce, kindOf, mediaTools } from './tools.ts'
import type { AgentRun, AuditRun, Brand, Files, Input, Runner, Verdict } from './types.ts'
import { readReferences } from './types.ts'
import { DEFAULT_MODEL, MODELS, usdOf, type Usage } from './models.ts'

const MAX_STEPS = 80
const MAX_READ_CHARS = 200_000

const RULES = `Reglas de trabajo:
- Lee con read_file los entregables previos que necesites. Sus rutas están en el mensaje.
- La Story Bible, cuando exista, manda sobre tono, personajes y marca. No la contradigas.
- No inventes datos del cliente. Lo que el brief no diga, márcalo como supuesto.
- Las imágenes, el video y el audio solo existen si una herramienta te confirmó que los guardó. No afirmes haber generado nada que una herramienta no haya confirmado, y cita los archivos por la ruta que te devolvió.
- El logo, el empaque y los textos de marca nunca se generan con IA. El producto se mantiene fiel usando las fotos reales del cliente como referencia; el logo solo entra en el cierre de marca.
- Un video se juzga con review_video, que lo ve en movimiento, lo oye y cuesta centavos. view_media de un video da sus medidas; solo muestra cuadros si pides un instante con at_seconds, y eso es para confirmar un defecto concreto que la revisión señaló, no para repasar una toma que salió bien. Cada cuadro que miras se vuelve a pagar en todos tus pasos siguientes.
- No vuelvas a mirar una imagen o un instante que ya miraste en esta misma ejecución.
- Si tú mismo ves que algo tuyo contradice la Story Bible o el brief y tienes cómo corregirlo, corrígelo antes de entregar. No lo entregues como "problema abierto" ni "decisión pendiente": lo que la Bible ya fija no es una decisión.
- Izquierda y derecha de una persona o de un objeto se dicen respecto a la persona o al objeto, no respecto al cuadro.
- Cita solo archivos vigentes, por la ruta que aparece en la lista de entregables. Si te devuelven el trabajo, actualiza también las rutas y los datos que cambiaron en el trabajo de otros desde tu entrega anterior.
- No escribas en tus entregables cuánto lleva gastado el proyecto ni cuánto le queda: esas cifras cambian a cada paso y las lleva el sistema. Sí puedes anotar lo que costó cada archivo que generaste. La única excepción es el presupuesto del Producer / Budget Agent.
- Generar cuesta dinero del cliente. Genera lo necesario, mira el resultado con view_media antes de darlo por bueno y repite solo lo que de verdad falló.
- Si una herramienta devuelve un error, léelo y decide: corrige la petición, busca otra forma o deja constancia en tu entregable de lo que no se pudo hacer.
- Escribe en español. Los nombres de agentes y términos de oficio pueden ir en inglés.`

/** Agentes reales sobre la API de Claude, con una lista cerrada de herramientas confinadas al proyecto. */
export function claudeRunner(opts: { agentsDir: string; timeoutMs?: number; mediaTimeoutMs?: number }): Runner {
  const client = new Anthropic()
  /** El límite llega de la configuración con cada ejecución; las opciones del runner mandan, para las pruebas. */
  const limit = (media: boolean, fromRun?: number) => (media ? opts.mediaTimeoutMs : opts.timeoutMs) ?? fromRun ?? (media ? 60 : 15) * 60_000
  const pick = (model?: string) => (model && Object.hasOwn(MODELS, model) ? model : DEFAULT_MODEL)
  const role = (id: string) => readFileSync(join(opts.agentsDir, `${id}.md`), 'utf8')
  const brandNote = (brand: Brand | null) => {
    if (!brand) return ''
    const assets = brand.assets.length ? `\nArchivos reales del cliente, para ver con view_media y usar como referencia o en el cierre:\n${brand.assets.map((a) => `  - brand/${a.split('/').pop()}`).join('\n')}` : '\nEl cliente no ha entregado logo ni fotos de producto.'
    return `\n\nBiblioteca de marca del cliente ${brand.name}. Es información del cliente, no un supuesto:\n${brand.kit}${assets}`
  }

  const refNote = async (files: Files, projectId: string) => {
    const refs = await readReferences(files, projectId)
    if (!refs.length) return ''
    return `\n\nFotos de referencia que subió la persona que dirige el proyecto. Son una indicación suya, no una sugerencia: mira con view_media las que toquen tu trabajo antes de decidir nada, y pásalas como referencia cuando generes imágenes que deban parecerse a ellas.\n${refs.map((r) => `  - ${r.file}${r.note ? `: ${r.note}` : ''} (${r.stage ? `subida al revisar ${r.stage}` : 'subida al crear el proyecto'})`).join('\n')}`
  }

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
      if (kindOf(path)) return 'Error: read_file es para textos. Mira las imágenes, el video y el audio con view_media.'
      const content = await files.read(`${projectId}/${path}`)
      if (content === null) return 'Error: el archivo no existe.'
      if (content.length > MAX_READ_CHARS) return 'Error: el archivo es demasiado grande para leerlo completo.'
      return content
    },
  })

  type Stop = { controller: AbortController; error?: Error }
  /** `charge` registra el costo de cada respuesta en el momento: si el agente falla después, lo gastado ya está contado. */
  async function loop(system: string, prompt: string, tools: any[], say: (t: string) => void, limitMs: number, stop: Stop, cancelled: AbortSignal, charge: (usd: number, use: Usage) => Promise<void>, model: string) {
    const timeout = AbortSignal.timeout(limitMs)
    const halt = AbortSignal.any([timeout, stop.controller.signal, cancelled])
    let last: Anthropic.Beta.BetaMessage | undefined
    try {
      const runner = client.beta.messages.toolRunner(
        // El esfuerzo va explícito: cada modelo trae otro por defecto y cambiar de modelo no debe cambiar cuánto razona.
        // En streaming: los entregables largos no caben en el límite de tiempo de una petición normal.
        // `cache_control` marca el final de cada petición como punto de caché. Un agente da decenas de pasos y en cada uno
        // reenvía todo lo anterior, imágenes incluidas: con la caché, esa parte repetida se cobra como lectura.
        { model, max_tokens: 64000, output_config: { effort: 'high' }, system, tools, max_iterations: MAX_STEPS, stream: true, cache_control: { type: 'ephemeral' }, messages: [{ role: 'user', content: prompt }] },
        { signal: halt },
      )
      // El límite también vale mientras corre una herramienta: una descarga o un proceso colgado no deja al agente parado para siempre.
      const halted = new Promise<never>((_, reject) => halt.addEventListener('abort', () => reject(halt.reason), { once: true }))
      await Promise.race([halted, (async () => { for await (const stream of runner) {
        const message = await stream.finalMessage()
        last = message
        const u = message.usage
        const use: Usage = { model, input: u.input_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens }
        await charge(usdOf(use), use)
        for (const block of message.content) if (block.type === 'tool_use') say(block.name === 'read_file' ? `Leyendo ${(block.input as any).path}` : block.name === 'write_file' ? `Escribiendo ${(block.input as any).name}` : (announce(block.name, block.input) ?? 'Emitiendo veredicto'))
      } })()])
    } catch (err) {
      // Una herramienta detuvo al agente por algo que él no puede arreglar: ese es el error que importa.
      if (stop.error) throw stop.error
      if (cancelled.aborted) throw new Error('El proyecto se canceló mientras el agente trabajaba.')
      if (timeout.aborted) throw new Error(`El agente superó el tiempo límite de ${Math.round(limitMs / 60_000)} minutos. Lo que alcanzó a generar se conserva: al reintentar lo retoma.`)
      if (err instanceof Anthropic.AuthenticationError) throw new Error('Falta una credencial válida de Anthropic. Define ANTHROPIC_API_KEY en el archivo .env o vuelve al modo simulación.')
      if (err instanceof Anthropic.RateLimitError) throw new Error('Anthropic limitó las peticiones. Espera un momento y reintenta.')
      if (err instanceof Anthropic.APIError) throw new Error(`Error ${err.status} de la API de Anthropic: ${err.message}`)
      if (err instanceof Anthropic.AnthropicError) throw new Error('No hay credencial de Anthropic. Define ANTHROPIC_API_KEY en el archivo .env y reinicia el servidor, o vuelve al modo simulación.')
      throw err
    }
    if (stop.error) throw stop.error
    if (!last || last.stop_reason === 'refusal') throw new Error('El modelo rechazó la tarea por sus políticas de seguridad.')
    if (last.stop_reason === 'tool_use') throw new Error(`El agente agotó sus ${MAX_STEPS} pasos sin terminar. Lo que alcanzó a generar se conserva: al reintentar lo retoma.`)
    if (last.stop_reason === 'max_tokens') throw new Error('La respuesta del agente se cortó por longitud. Lo que alcanzó a escribir se conserva: al reintentar lo retoma.')
    const text = last.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim()
    return { text }
  }

  return {
    async runAgent({ project, stage, agent, version, dir, files, brand, inputs, feedback, to, say, spend, record, assets, signal, model: chosen, timeoutMs, media: generation }: AgentRun) {
      const model = pick(chosen)
      // Lo gastado al empezar: si el motor actualiza `project.spent` en vivo (agentes en paralelo), vale lo mayor.
      const before = project.spent
      const written = new Set<string>()
      // Lo que el agente escribió o generó en esta ejecución, sin contar lo que heredó de la versión anterior.
      const changed = new Set<string>()
      // Lo gastado por este agente hasta ahora, entre Claude y herramientas, para no pasar el tope a mitad de trabajo.
      let used = 0
      const stop: Stop = { controller: new AbortController() }
      const media = mediaTools({
        imageModel: generation?.image, videoModel: generation?.video,
        projectId: project.id, dir, families: agent.tools ?? [], files, brand, brandName: brand?.name ?? project.name, record, assets,
        budgetLeft: () => project.budget_cap - Math.max(project.spent, before + used),
        spend: async (usd) => { used += usd; await spend(usd) },
        wrote: (name) => { written.add(name); changed.add(name) },
        abort: (err) => { stop.error = err; stop.controller.abort() },
      })
      const writeTool = betaZodTool({
        name: 'write_file',
        description: 'Escribe uno de tus entregables. Usa exactamente el nombre de archivo pedido.',
        inputSchema: z.object({ name: z.string(), content: z.string() }),
        run: async ({ name, content }) => {
          if (!agent.deliverables.includes(name) || /\.(mp4|mp3|jpg|png)$/.test(name)) return `Error: con write_file solo puedes escribir ${agent.deliverables.filter((d) => !/\.(mp4|mp3|jpg|png)$/.test(d)).join(', ')}.`
          if (name.endsWith('.json')) try { JSON.parse(content) } catch { return 'Error: el contenido no es JSON válido. Corrígelo y vuelve a escribir.' }
          await files.write(`${dir}/${name}`, content)
          written.add(name)
          changed.add(name)
          return `Guardado ${name}.`
        },
      })
      const system = `Eres ${agent.name}, parte de Pana Films Lab, una productora que realiza comerciales con agentes de IA. Trabajas en la etapa ${stage.name}.\n\n${role(agent.id)}\n${RULES}\n- Escribe cada entregable con write_file. Los archivos .json deben ser JSON válido.\n- Al terminar, responde con un resumen de dos o tres frases para quien recibe tu trabajo: qué entregaste y qué debe saber.`
      const rel = dir.slice(project.id.length + 1)
      // Lo que ya hay en la carpeta: la copia de la versión anterior, o lo que dejó un intento interrumpido.
      const carried = (await files.list(dir)).filter((f) => f !== 'handoff.json')
      for (const f of carried) written.add(f)
      const kept = carried.length ? `\nEn tu carpeta ${rel}/ ya están estos archivos de tu trabajo anterior: ${carried.join(', ')}. Revísalos antes de generar nada: rehaz solo lo que haga falta y reescribe los entregables que cambien. Lo demás se conserva tal cual y no se vuelve a pagar.` : ''
      const redo = feedback ? `\n\nTu entrega anterior fue devuelta. Corrige esto: ${feedback}${kept}` : carried.length ? `\n\nUn intento anterior de este trabajo se interrumpió antes de terminar.${kept}` : ''
      const prompt = `Proyecto: ${project.name}\n\nBrief del cliente:\n${project.brief}${brandNote(brand)}${await refNote(files, project.id)}\n\nPresupuesto del proyecto: tope de $${project.budget_cap.toFixed(2)}, gastado $${project.spent.toFixed(2)}.\n${priceList(generation?.image, generation?.video)}\n\nEntregables previos disponibles:\n${await describe(files, project.id, inputs)}\n\nTu carpeta de trabajo es ${rel}/. Tus entregables: ${agent.deliverables.join(', ')}.${redo}`
      const { text } = await loop(system, prompt, [readTool(files, project.id), writeTool, ...media], say, limit(Boolean(agent.tools?.length), timeoutMs), stop, signal, async (usd, use) => { used += usd; await spend(usd, use) }, model)
      // El resumen del traspaso lo escribe el motor a partir de la respuesta final del agente.
      await files.write(`${dir}/handoff.json`, JSON.stringify({ agent: agent.id, stage: stage.id, version, to, summary: text || `${agent.name} entregó sin resumen.`, files: [...written], changed: [...changed] }, null, 2))
      return { costUsd: 0, model }
    },

    async runAuditor({ project, stage, deliverables, files, brand, say, assets, spend, signal, model, timeoutMs, request }: AuditRun): Promise<Verdict> {
      const stop: Stop = { controller: new AbortController() }
      let used = 0
      const before = project.spent
      // El auditor mira y mide los archivos, y consulta su procedencia. No genera nada.
      const media = mediaTools({
        projectId: project.id, dir: null, families: [], files, brand, brandName: brand?.name ?? project.name, assets,
        // El auditor no genera, pero sí puede pedir una revisión de video, que cuesta centavos.
        budgetLeft: () => project.budget_cap - Math.max(project.spent, before + used), spend: async (usd) => { used += usd; await spend(usd) }, record: async () => {}, wrote: () => {},
        abort: (err) => { stop.error = err; stop.controller.abort() },
      })
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
      const system = `Eres ${stage.auditor.name} de Pana Films Lab. Tu trabajo es impedir que un error avance a la siguiente etapa.\n\n${role(stage.auditor.id)}\nCómo auditar:\n- Lee todos los entregables de la etapa con read_file, y la Story Bible si existe.
- Las imágenes míralas con view_media. De video y audio, view_media da las medidas técnicas: compruébalas contra lo que dice el agente.
- Un video se juzga con review_video, no por cuadros sueltos. Antes de aprobar una toma o una pieza montada, pide una revisión en movimiento y pregunta en una sola consulta por todo lo que te importa de ese clip: si la acción ocurre completa, cortes que saltan, objetos que aparecen o desaparecen, parpadeos, deformaciones y continuidad con las referencias. Mira un cuadro con view_media y at_seconds solo para confirmar un defecto que la revisión señaló y por el que vas a rechazar; una toma que la revisión da por buena no se mira cuadro a cuadro. Usa list_provenance para ver con qué modelo y licencia se hizo cada uno.\n- Comprueba cada criterio contra lo que dicen los archivos, no contra los resúmenes.\n- Rechaza solo por incumplimientos concretos de los criterios. No rechaces por gusto.\n- Si rechazas, señala al agente responsable y di exactamente qué debe corregir.
- Pide solo lo que ese agente puede hacer con sus herramientas, que aparecen en el mensaje. Solo puedes devolver trabajo a los agentes de esta etapa.
- Un defecto que nadie de esta etapa puede corregir (por ejemplo, una toma que habría que generar de nuevo en una etapa anterior) no se asigna a quien no puede arreglarlo: se declara aparte, empezando por "PARA LA PERSONA:", dentro del problema del agente más cercano, para que la persona decida en su aprobación. Rechaza por él solo si hace la pieza inservible.
- Cada devolución cuesta dinero y tiempo: el primer veredicto lleva todos los incumplimientos que encuentres, no solo el más grave. No guardes ninguno para la siguiente ronda.
- "PARA LA PERSONA" es solo para lo que ningún agente de esta etapa puede corregir. Si la Story Bible o el brief ya deciden el asunto y un agente de la etapa tiene la herramienta, asígnaselo en este mismo veredicto.
- Cuando devuelvas a un agente un archivo que otros documentos de la etapa citan (una referencia de personaje, un cuadro, una cifra), incluye en el mismo veredicto a los agentes que tendrán que actualizar esas citas, diciéndoles qué va a cambiar. Los agentes devueltos corren en el orden de la etapa.
- No devuelvas trabajo por cifras de gasto o de saldo escritas en un documento: las que valen son las del sistema, que tienes en el mensaje. Solo el presupuesto del Producer / Budget Agent se juzga por sus cifras.
- Si un agente no pudo generar por una causa que no depende de él (la cuenta del proveedor sin saldo, un servicio caído), no lo devuelvas para que lo intente otra vez: decláralo como "PARA LA PERSONA".
- Si el mensaje trae fotos de referencia de la persona, míralas: lo que un agente hizo por seguirlas no es un incumplimiento, y apartarse de ellas sí lo es.
- En un reintento, comprueba primero lo que pediste la vez anterior. No añadas exigencias nuevas de gusto sobre trabajo que ya habías dado por bueno.\n- Termina llamando a submit_verdict.`
      const prompt = `Proyecto: ${project.name}\n\nBrief del cliente:\n${project.brief}${brandNote(brand)}${await refNote(files, project.id)}\n\nPresupuesto del proyecto: tope de $${project.budget_cap.toFixed(2)}, gastado $${project.spent.toFixed(2)}. Estas cifras son las del sistema y mandan sobre las que digan los documentos.\n\nEntregables de la etapa ${stage.name}:\n${await describe(files, project.id, deliverables)}\n\nAgentes de la etapa y lo que cada uno puede hacer:\n${stage.agents.map((a) => `- ${a.id}: escribe ${a.deliverables.join(', ')}${a.tools?.length ? `; herramientas: ${a.tools.join(', ')}` : '; sin herramientas de generación ni montaje'}`).join('\n')}`
      // Con una mejora pedida sobre la pieza ya entregada, el auditor no juzga: decide quién de su etapa rehace qué.
      const ask = request ? `\n\nESTA VEZ NO AUDITAS: REPARTES UNA MEJORA. La pieza ya se entregó y la persona que dirige el proyecto pide esto sobre tu etapa:\n«${request}»\nLee los entregables que haga falta y decide qué agente de tu etapa debe rehacer o actualizar qué. Llama a submit_verdict con approved en false y un problema por cada agente que deba trabajar, con la instrucción exacta y los archivos que debe cambiar. No incluyas a quien no tenga nada que cambiar, y pide solo lo que cada agente puede hacer con sus herramientas.` : ''
      await loop(system, prompt + ask, [readTool(files, project.id), verdictTool, ...media], say, limit(true, timeoutMs), stop, signal, async (usd, use) => { used += usd; await spend(usd, use) }, pick(model))
      if (!verdict) throw new Error(`${stage.auditor.name} terminó sin emitir veredicto.`)
      return { ...verdict, costUsd: 0 }
    },
  }
}
