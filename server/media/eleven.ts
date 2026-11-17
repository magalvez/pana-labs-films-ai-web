import { MODELS } from './prices.ts'
import type { Generated } from './fal.ts'

const API = 'https://api.elevenlabs.io'
const key = () => {
  if (!process.env.ELEVENLABS_API_KEY) throw new Error('Falta ELEVENLABS_API_KEY en el archivo .env: sin ella no se puede generar voz, música ni efectos.')
  return process.env.ELEVENLABS_API_KEY
}

async function eleven(path: string, body?: object): Promise<Response> {
  const res = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'xi-api-key': key(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5 * 60_000),
  })
  if (res.ok) return res
  const json = await res.json().catch(() => ({}))
  const detail = Array.isArray(json.detail) ? json.detail.map((d: any) => d.msg).join('; ') : (json.detail?.message ?? json.detail ?? res.statusText)
  throw new Error(`ElevenLabs respondió ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}
const audio = async (res: Response) => new Uint8Array(await res.arrayBuffer())

export async function listVoices() {
  const { voices } = await (await eleven('/v2/voices?page_size=100')).json()
  return (voices as any[]).map((v) => ({ id: v.voice_id, name: v.name, gender: v.labels?.gender, age: v.labels?.age, accent: v.labels?.accent, language: v.labels?.language, use: v.labels?.use_case, description: v.description ?? v.labels?.descriptive }))
}

let license: { text: Promise<string>; until: number } | undefined
/** La licencia de lo que genera ElevenLabs depende del plan de la cuenta. Se vuelve a consultar cada diez minutos: el plan puede cambiar. */
export function audioLicense(): Promise<string> {
  if (license && license.until > Date.now()) return license.text
  const text = eleven('/v1/user/subscription')
    .then((r) => r.json())
    .then((s) => (s.tier === 'free' ? 'ElevenLabs, plan gratuito: sin licencia de uso comercial. Hay que pasar a un plan de pago antes de entregar al cliente.' : `ElevenLabs, plan ${s.tier}: uso comercial permitido según sus términos.`))
    .catch(() => {
      license = undefined
      return 'ElevenLabs: licencia sin confirmar, no se pudo leer el plan de la cuenta.'
    })
  license = { text, until: Date.now() + 10 * 60_000 }
  return text
}

export async function speech(o: { text: string; voiceId: string }): Promise<Generated> {
  const res = await eleven(`/v1/text-to-speech/${encodeURIComponent(o.voiceId)}?output_format=mp3_44100_128`, { text: o.text, model_id: MODELS.speech.model })
  return { bytes: await audio(res), contentType: 'audio/mpeg', model: MODELS.speech.model, costUsd: (o.text.length / 1000) * MODELS.speech.usdPer1kChars, seed: null }
}

export async function music(o: { prompt: string; durationSeconds: number }): Promise<Generated> {
  const res = await eleven('/v1/music?output_format=mp3_44100_128', { prompt: o.prompt, music_length_ms: Math.round(o.durationSeconds * 1000), model_id: MODELS.music.model, force_instrumental: true })
  return { bytes: await audio(res), contentType: 'audio/mpeg', model: MODELS.music.model, costUsd: (o.durationSeconds / 60) * MODELS.music.usdPerMinute, seed: null }
}

export async function soundEffect(o: { prompt: string; durationSeconds: number }): Promise<Generated> {
  const res = await eleven('/v1/sound-generation?output_format=mp3_44100_128', { text: o.prompt, duration_seconds: o.durationSeconds, model_id: MODELS.sfx.model })
  return { bytes: await audio(res), contentType: 'audio/mpeg', model: MODELS.sfx.model, costUsd: (o.durationSeconds / 60) * MODELS.sfx.usdPerMinute, seed: null }
}
