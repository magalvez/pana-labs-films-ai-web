import Anthropic from '@anthropic-ai/sdk'
import type { Brand, Project } from './engine/types.ts'
import { DEFAULT_MODEL, usdOf, type Usage } from './engine/models.ts'
import { sampleMedia } from './engine/simRunner.ts'
import * as fal from './media/fal.ts'

export const ASPECTS = ['16:9', '3:4', '1:1', '9:16'] as const
export type Aspect = (typeof ASPECTS)[number]
export type Suggestion = { idea: string; boards: { title: string; prompt: string; note: string; aspect: Aspect }[]; costUsd: number; use?: Usage }
export type Picture = { bytes: Uint8Array; model: string; provider: string; license: string; costUsd: number; seed: string | null }

/** Quien propone qué explorar y genera las opciones, antes de que arranque la producción. */
export type Explorer = {
  suggest(input: { project: Project; brand: Brand | null }): Promise<Suggestion>
  image(o: { project: Project; prompt: string; aspect: Aspect; referenceUrls: string[]; model: string }): Promise<Picture>
}

const SYSTEM = `Eres el director creativo de Pana Films Lab. Antes de producir un comercial, el estudio explora su look con imágenes fijas para que el cliente lo apruebe y para que todos los agentes trabajen después con las mismas referencias.

A partir del brief propones la idea en dos o tres frases y entre tres y cuatro tableros de exploración. Cada tablero busca UNA sola cosa:
- La persona protagonista: cuerpo entero y rostro claro, sobre fondo neutro, sin producto. Formato 3:4.
- La locación principal: sin personas ni producto. Formato 16:9.
- El look del comercial: un cuadro clave con su luz, su paleta y su encuadre. Formato 16:9.
- Solo si el brief lo pide: un segundo personaje, o el producto en uso.

Reglas de cada prompt de imagen:
- En inglés, de 40 a 90 palabras, concreto: sujeto, edad y rasgos, vestuario, lugar, hora del día, luz, lente y encuadre, paleta.
- Fotografía publicitaria realista salvo que el brief pida otro estilo.
- Nunca pidas logos, marcas, empaques con texto ni letras en la imagen.
- No inventes datos del cliente: lo que el brief no diga, elígelo con criterio y que se pueda cambiar.

Responde solo con JSON, sin texto alrededor, con esta forma:
{"idea":"...","boards":[{"title":"Protagonista","prompt":"...","note":"...","aspect":"3:4"}]}
"title" es corto y en español. "note" es la indicación en español que recibirán los agentes sobre qué deben respetar de la imagen elegida, por ejemplo "Es la protagonista en todos los planos: misma edad, piel, pelo y vestuario". "aspect" es 16:9, 3:4, 1:1 o 9:16.`

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** Lee la propuesta del modelo aunque llegue envuelta en texto. Lo que no cumple la forma se descarta. */
export function parseSuggestion(raw: string): Omit<Suggestion, 'costUsd' | 'use'> {
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}')
  let data: any = null
  try { data = JSON.parse(raw.slice(start, end + 1)) } catch { /* se trata abajo */ }
  const boards = (Array.isArray(data?.boards) ? data.boards : []).map((b: any) => ({
    title: text(b?.title, 60), prompt: text(b?.prompt, 1500), note: text(b?.note, 400),
    aspect: (ASPECTS as readonly string[]).includes(b?.aspect) ? (b.aspect as Aspect) : '16:9',
  })).filter((b: { title: string; prompt: string }) => b.title && b.prompt.length >= 10).slice(0, 4)
  if (!boards.length) throw new Error('No se pudo armar la propuesta de tableros. Vuelve a pedirla o escribe los tableros a mano.')
  return { idea: text(data?.idea, 800), boards }
}

/** Propuesta escrita por Claude e imágenes generadas en fal.ai. */
export function claudeExplorer(): Explorer {
  const client = new Anthropic()
  return {
    async suggest({ project, brand }) {
      const message = await client.messages.create({
        model: DEFAULT_MODEL, max_tokens: 4000, system: SYSTEM,
        messages: [{ role: 'user', content: `Proyecto: ${project.name}\nCliente: ${brand?.name ?? 'sin indicar'}\n\nBrief del cliente:\n${project.brief}${brand?.kit ? `\n\nBiblioteca de marca:\n${brand.kit}` : ''}` }],
      })
      const u = message.usage
      const use: Usage = { model: DEFAULT_MODEL, input: u.input_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens }
      const raw = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')
      return { ...parseSuggestion(raw), costUsd: usdOf(use), use }
    },
    async image({ prompt, aspect, referenceUrls, model }) {
      const g = await fal.generateImage({ prompt, aspect, referenceUrls, model })
      return { bytes: g.bytes, model: g.model, provider: 'fal.ai', license: 'Generado en fal.ai: uso comercial según los términos de fal.ai y del modelo.', costUsd: g.costUsd, seed: g.seed }
    },
  }
}

/** Para simulación y pruebas: tableros de muestra e imágenes hechas en el servidor, sin gastar. */
export function simExplorer(media: () => Promise<Uint8Array> = () => sampleMedia('image')): Explorer {
  return {
    async suggest({ project }) {
      return {
        idea: `Simulación de la idea para ${project.name}.`, costUsd: 0,
        boards: [
          { title: 'Protagonista', prompt: 'Simulated portrait of the lead character, full body, neutral background', note: 'Es la protagonista en todos los planos.', aspect: '3:4' },
          { title: 'Locación', prompt: 'Simulated wide shot of the main location, no people, morning light', note: 'Es el lugar donde ocurre el comercial.', aspect: '16:9' },
          { title: 'Look', prompt: 'Simulated key frame showing palette, light and framing of the commercial', note: 'Luz, paleta y encuadre de toda la pieza.', aspect: '16:9' },
        ],
      }
    },
    async image() {
      return { bytes: await media(), model: 'simulación', provider: 'servidor', license: 'Archivo de muestra generado en el servidor.', costUsd: 0, seed: null }
    },
  }
}
