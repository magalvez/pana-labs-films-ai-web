/**
 * Modelos y tarifas publicadas por los proveedores (USD, noviembre de 2026).
 * ponytail: el costo se estima con esta tabla, no con la factura real; revisar las tarifas en fal.ai/pricing
 * y elevenlabs.io/pricing/api cuando cambien, o leer la facturación del proveedor si hace falta exactitud.
 */
/** Modelos de imagen que se pueden elegir en la configuración. Endpoints y precios de sus páginas en fal.ai. */
export const IMAGE_MODELS: Record<string, { name: string; note: string; endpoint: string; editEndpoint: string; usdPerImage: number }> = {
  'nano-banana-2': { name: 'Nano Banana 2', note: 'El que usa el estudio por defecto.', endpoint: 'fal-ai/nano-banana-2', editEndpoint: 'fal-ai/nano-banana-2/edit', usdPerImage: 0.08 },
  'nano-banana-pro': { name: 'Nano Banana Pro', note: 'Más fiel a las referencias y al texto del prompt; casi el doble de caro.', endpoint: 'fal-ai/nano-banana-pro', editEndpoint: 'fal-ai/nano-banana-pro/edit', usdPerImage: 0.15 },
}
/** Modelos de la toma final. Los tres reciben lo mismo: imagen de partida, prompt y duración, sin audio. */
// ponytail: todos en clips de 5 o 10 s, como asumen las instrucciones de los agentes; Kling 3.0 admite de 3 a 15 s si se quiere pagar menos por plano corto.
export const VIDEO_MODELS: Record<string, { name: string; note: string; endpoint: string; usdPerSecond: number; durations: readonly number[] }> = {
  'kling-2.6-pro': { name: 'Kling 2.6 Pro', note: 'El que usa el estudio por defecto.', endpoint: 'fal-ai/kling-video/v2.6/pro/image-to-video', usdPerSecond: 0.07, durations: [5, 10] },
  'kling-3-standard': { name: 'Kling 3.0 Standard', note: 'Generación nueva de Kling, a 720p.', endpoint: 'fal-ai/kling-video/v3/standard/image-to-video', usdPerSecond: 0.084, durations: [5, 10] },
  'kling-3-pro': { name: 'Kling 3.0 Pro', note: 'Generación nueva de Kling, a 1080p. El más caro.', endpoint: 'fal-ai/kling-video/v3/pro/image-to-video', usdPerSecond: 0.112, durations: [5, 10] },
}
export const DEFAULT_IMAGE = 'nano-banana-2'
export const DEFAULT_VIDEO = 'kling-2.6-pro'
export const imageModel = (id?: string) => IMAGE_MODELS[id && Object.hasOwn(IMAGE_MODELS, id) ? id : DEFAULT_IMAGE]
export const videoModel = (id?: string) => VIDEO_MODELS[id && Object.hasOwn(VIDEO_MODELS, id) ? id : DEFAULT_VIDEO]

export const MODELS = {
  // Prueba barata de un movimiento antes de pagar la toma final.
  draft: { endpoint: 'fal-ai/pixverse/v6/image-to-video', usdPerSecond: 0.025, durations: [5, 8, 10] },
  speech: { model: 'eleven_multilingual_v2', usdPer1kChars: 0.08 },
  music: { model: 'music_v1', usdPerMinute: 0.15 },
  sfx: { model: 'eleven_text_to_sound_v2', usdPerMinute: 0.12 },
  // Revisión de video en movimiento. Esta tarifa de Gemini 3.8 Flash vale hasta el 31/dic/2026; después se duplica.
  // `fallback` cuesta lo mismo y se usa cuando el principal responde que está saturado.
  review: { model: 'gemini-3.8-flash', fallback: 'gemini-3.6-flash', usdPerMTokIn: 0.75, usdPerMTokOut: 3.75 },
} as const

/** Las tarifas que ve cada agente, con los modelos de imagen y video elegidos en la configuración. */
export const priceList = (image?: string, video?: string) => `Tarifas de generación vigentes, en USD:
- Imagen (${imageModel(image).endpoint}): ${imageModel(image).usdPerImage} por imagen.
- Video de prueba (${MODELS.draft.endpoint}, 360p): ${MODELS.draft.usdPerSecond} por segundo.
- Video final (${videoModel(video).endpoint}, sin audio): ${videoModel(video).usdPerSecond} por segundo, en clips de ${videoModel(video).durations.join(' o ')} segundos.
- Voz (ElevenLabs ${MODELS.speech.model}): ${MODELS.speech.usdPer1kChars} por mil caracteres.
- Música (ElevenLabs): ${MODELS.music.usdPerMinute} por minuto. Efectos de sonido: ${MODELS.sfx.usdPerMinute} por minuto.
- Revisión de video en movimiento (review_video): unos 0.02 por cada 15 segundos de video.
- Montaje, color, mezcla, títulos y versiones: sin costo, se hacen en el servidor.`
