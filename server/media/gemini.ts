import { setTimeout as sleep } from 'node:timers/promises'
import { MODELS } from './prices.ts'

const key = () => {
  if (!process.env.GEMINI_API_KEY) throw new Error('Falta GEMINI_API_KEY en el archivo .env: sin ella no se puede revisar video en movimiento.')
  return process.env.GEMINI_API_KEY
}

/** Lo que cabe en una sola petición con el video dentro. Una pieza más pesada habría que subirla antes con la API de archivos. */
export const MAX_REVIEW_BYTES = 18 * 1024 * 1024

/**
 * Gemini mira el video completo, con su audio, y contesta una pregunta sobre lo que ocurre en el tiempo.
 * `fps` es cuántos cuadros por segundo examina: un defecto de un instante necesita más que el cuadro por segundo que usa por defecto.
 */
export async function reviewVideo(o: { bytes: Uint8Array; question: string; fps: number; startSeconds?: number; endSeconds?: number }): Promise<{ text: string; costUsd: number; model: string }> {
  const m = MODELS.review
  const processing = {
    type: 'static', fps: o.fps,
    ...(o.startSeconds !== undefined ? { start_offset: `${o.startSeconds}s` } : {}),
    ...(o.endSeconds !== undefined ? { end_offset: `${o.endSeconds}s` } : {}),
  }
  const request = JSON.stringify({ model: m.model, input: [{ type: 'text', text: o.question }, { type: 'video', data: Buffer.from(o.bytes).toString('base64'), mime_type: 'video/mp4', processing }] })
  let res!: Response
  let body: any
  // Gemini devuelve 503 o 429 cuando está saturado; suele pasar en segundos.
  for (let attempt = 1; ; attempt++) {
    res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', { method: 'POST', headers: { 'x-goog-api-key': key(), 'Content-Type': 'application/json' }, body: request, signal: AbortSignal.timeout(8 * 60_000) })
    body = await res.json().catch(() => ({}))
    if (res.ok || (res.status !== 503 && res.status !== 429) || attempt >= 4) break
    await sleep(5000 * attempt)
  }
  if (!res.ok) throw new Error(`Gemini respondió ${res.status}: ${body.error?.message ?? res.statusText}`)
  const text = (body.steps ?? []).filter((s: any) => s.type === 'model_output').flatMap((s: any) => s.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim()
  if (!text) throw new Error(`Gemini no devolvió una revisión (estado ${body.status ?? 'desconocido'})`)
  const u = body.usage ?? {}
  // Lo que el modelo razona antes de contestar se cobra como salida.
  const costUsd = ((u.total_input_tokens ?? 0) * m.usdPerMTokIn + ((u.total_output_tokens ?? 0) + (u.total_thought_tokens ?? 0)) * m.usdPerMTokOut) / 1e6
  return { text, costUsd, model: m.model }
}
