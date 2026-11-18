import { setTimeout as sleep } from 'node:timers/promises'
import { MODELS } from './prices.ts'

/** La revisión en movimiento es una ayuda opcional: sin clave, el agente sigue con la revisión por cuadros. */
export const reviewAvailable = () => Boolean(process.env.GEMINI_API_KEY)

/** El video viaja dentro de la petición, en base64 (un tercio más grande), y el límite de la petición ronda los 20 MB. */
export const MAX_REVIEW_BYTES = 14 * 1024 * 1024
export const REVIEW_FPS = 10

// La tarifa de este modelo se duplica el 1/ene/2027.
const rate = () => (Date.now() >= Date.parse('2027-01-01T00:00:00Z') ? 2 : 1)
/** Costo aproximado de revisar un clip: unos 70 tokens por cuadro más 32 por segundo de audio, y la respuesta razonada. */
export const reviewEstimateUsd = (seconds: number) => ((seconds * (REVIEW_FPS * 70 + 32) + 300) * MODELS.review.usdPerMTokIn + 3000 * MODELS.review.usdPerMTokOut) / 1e6 * rate()

/**
 * Gemini mira el video completo, con su audio, y contesta una pregunta sobre lo que ocurre en el tiempo.
 * Examina diez cuadros por segundo: un defecto de un instante no se ve con el cuadro por segundo que usa por defecto.
 */
export async function reviewVideo(o: { bytes: Uint8Array; question: string; seconds: number; startSeconds?: number; endSeconds?: number }): Promise<{ text: string; costUsd: number; model: string }> {
  const m = MODELS.review
  const processing = {
    type: 'static', fps: REVIEW_FPS,
    ...(o.startSeconds !== undefined ? { start_offset: `${o.startSeconds}s` } : {}),
    ...(o.endSeconds !== undefined ? { end_offset: `${o.endSeconds}s` } : {}),
  }
  const request = (model: string) => JSON.stringify({ model, input: [{ type: 'text', text: o.question }, { type: 'video', data: Buffer.from(o.bytes).toString('base64'), mime_type: 'video/mp4', processing }] })
  let res: Response | undefined
  let body: any
  let model: string = m.model
  // Gemini devuelve 503 o 429 cuando está saturado, y a veces la conexión se corta; suele pasar en segundos.
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', { method: 'POST', headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY ?? '', 'Content-Type': 'application/json' }, body: request(model), signal: AbortSignal.timeout(4 * 60_000) })
      body = await res.json().catch(() => null)
      if (res.ok || (res.status !== 503 && res.status !== 429)) break
      // Saturado: el siguiente intento va al modelo de respaldo.
      model = model === m.model ? m.fallback : m.model
    } catch (err) {
      if (attempt >= 4) throw new Error(`No se pudo contactar con Gemini: ${err instanceof Error ? err.message : err}`)
    }
    if (attempt >= 4) break
    await sleep(4000 * attempt)
  }
  if (!res?.ok) throw new Error(`Gemini respondió ${res?.status}: ${body?.error?.message ?? res?.statusText}`)
  const text = (body?.steps ?? []).filter((s: any) => s.type === 'model_output').flatMap((s: any) => s.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim()
  if (body?.status !== 'completed' || !text) throw new Error(`Gemini no completó la revisión (estado ${body?.status ?? 'desconocido'})`)
  const u = body.usage
  // Lo que el modelo razona antes de contestar se cobra como salida. Si no informa del consumo, se cobra lo estimado.
  const measured = u ? ((u.total_input_tokens ?? 0) * m.usdPerMTokIn + ((u.total_output_tokens ?? 0) + (u.total_thought_tokens ?? 0)) * m.usdPerMTokOut) / 1e6 * rate() : 0
  return { text, costUsd: measured > 0 ? measured : reviewEstimateUsd(o.seconds), model }
}
