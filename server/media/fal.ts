import { setTimeout as sleep } from 'node:timers/promises'
import { MODELS, imageModel, lipSyncUsd, videoModel } from './prices.ts'

const key = () => {
  if (!process.env.FAL_KEY) throw new Error('Falta FAL_KEY en el archivo .env: sin ella no se puede generar imagen ni video.')
  return process.env.FAL_KEY
}

/** Envía un trabajo a la cola de fal.ai y espera el resultado. */
async function fal(endpoint: string, input: object, timeoutMs: number): Promise<any> {
  const headers = { Authorization: `Key ${key()}`, 'Content-Type': 'application/json' }
  const call = (url: string, init: RequestInit = {}) => fetch(url, { ...init, headers, signal: AbortSignal.timeout(60_000) })
  const fail = async (res: Response) => {
    const body = await res.json().catch(() => ({}))
    const raw = Array.isArray(body.detail) ? body.detail.map((d: any) => d.msg).join('; ') : (body.detail ?? body.error?.message ?? res.statusText)
    return new Error(`fal.ai respondió ${res.status} en ${endpoint}: ${typeof raw === 'string' ? raw : JSON.stringify(raw)}`)
  }
  const submitted = await call(`https://queue.fal.run/${endpoint}`, { method: 'POST', body: JSON.stringify(input) })
  if (!submitted.ok) throw await fail(submitted)
  const { status_url, response_url } = await submitted.json()
  const deadline = Date.now() + timeoutMs
  // Desde aquí fal.ai ya está trabajando y cobrando. Un tropiezo de red al consultar no es motivo para
  // abandonar el trabajo: se insiste varias veces antes de darlo por perdido.
  for (let misses = 0; ; ) {
    let status: string | undefined
    try {
      const res = await call(status_url)
      if (res.ok) status = (await res.json()).status
      else if (res.status < 500 && res.status !== 429) throw await fail(res)
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('fal.ai respondió')) throw err
    }
    if (status === 'COMPLETED') break
    if (status === undefined) {
      if (++misses > 8) throw new Error(`Se perdió el contacto con fal.ai mientras generaba en ${endpoint}. Revisa en fal.ai si el trabajo terminó antes de repetirlo`)
    } else {
      misses = 0
      if (status !== 'IN_QUEUE' && status !== 'IN_PROGRESS') throw new Error(`fal.ai devolvió el estado ${status} en ${endpoint}`)
    }
    if (Date.now() > deadline) throw new Error(`fal.ai tardó más de ${Math.round(timeoutMs / 60000)} minutos en ${endpoint}`)
    await sleep(3000)
  }
  // Un trabajo que falla dentro del modelo termina "COMPLETED" y trae el error en la respuesta.
  return retry(async () => {
    const result = await call(response_url)
    // Un 5xx o un 429 al recoger el resultado es pasajero: el trabajo ya está hecho y cobrado, se insiste.
    if (result.status >= 500 || result.status === 429) throw new Error(`fal.ai respondió ${result.status} al recoger el resultado de ${endpoint}`)
    if (!result.ok) throw Object.assign(await fail(result), { final: true })
    return result.json()
  })
}

/** Reintenta lo que falla por red: a estas alturas el trabajo ya está hecho y pagado. */
async function retry<T>(fn: () => Promise<T>, times = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i >= times || (err as { final?: boolean }).final) throw err
      await sleep(2000 * i)
    }
  }
}

const download = (url: string) => retry(async () => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) })
  if (!res.ok) throw new Error(`No se pudo descargar el archivo generado (${res.status})`)
  return new Uint8Array(await res.arrayBuffer())
})

export type Generated = { bytes: Uint8Array; contentType: string; model: string; costUsd: number; seed: string | null }

/** Con imágenes de referencia el modelo las usa para mantener personaje, locación o producto. */
export async function generateImage(o: { prompt: string; aspect: string; referenceUrls: string[]; model?: string }): Promise<Generated> {
  const m = imageModel(o.model)
  const endpoint = o.referenceUrls.length ? m.editEndpoint : m.endpoint
  const out = await fal(endpoint, { prompt: o.prompt, aspect_ratio: o.aspect, num_images: 1, output_format: 'jpeg', ...(o.referenceUrls.length ? { image_urls: o.referenceUrls } : {}) }, 5 * 60_000)
  const image = out.images?.[0]
  if (!image?.url) throw new Error(`fal.ai no devolvió imagen: ${String(out.description ?? '').slice(0, 200) || 'respuesta vacía'}`)
  return { bytes: await download(image.url), contentType: 'image/jpeg', model: endpoint, costUsd: m.usdPerImage, seed: out.seed == null ? null : String(out.seed) }
}

export async function generateVideo(o: { prompt: string; imageUrl: string; durationSeconds: number; quality: 'draft' | 'final'; negativePrompt?: string; model?: string; /** Personajes y objetos de referencia (solo Kling 3.0): imagen frontal y otras vistas. */ elements?: { frontal: string; references: string[] }[] }): Promise<Generated> {
  const m = o.quality === 'final' ? videoModel(o.model) : MODELS.draft
  const input = o.quality === 'final'
    ? { prompt: o.prompt, start_image_url: o.imageUrl, duration: String(o.durationSeconds), generate_audio: false, ...(o.elements?.length ? { elements: o.elements.map((e) => ({ frontal_image_url: e.frontal, ...(e.references.length ? { reference_image_urls: e.references } : {}) })) } : {}), ...(o.negativePrompt ? { negative_prompt: o.negativePrompt } : {}) }
    : { prompt: o.prompt, image_url: o.imageUrl, duration: o.durationSeconds, resolution: '360p', ...(o.negativePrompt ? { negative_prompt: o.negativePrompt } : {}) }
  const out = await fal(m.endpoint, input, 15 * 60_000)
  if (!out.video?.url) throw new Error('fal.ai no devolvió video')
  return { bytes: await download(out.video.url), contentType: 'video/mp4', model: m.endpoint, costUsd: m.usdPerSecond * o.durationSeconds, seed: out.seed == null ? null : String(out.seed) }
}

/** Ajusta la boca del personaje de un video a una pista de voz. El video debe durar de 2 a 10 s y la voz de 2 a 60 s. */
export async function lipSync(o: { videoUrl: string; audioUrl: string; videoSeconds: number }): Promise<Generated> {
  const out = await fal(MODELS.lipsync.endpoint, { video_url: o.videoUrl, audio_url: o.audioUrl }, 10 * 60_000)
  if (!out.video?.url) throw new Error('fal.ai no devolvió video')
  return { bytes: await download(out.video.url), contentType: 'video/mp4', model: MODELS.lipsync.endpoint, costUsd: lipSyncUsd(o.videoSeconds), seed: null }
}
