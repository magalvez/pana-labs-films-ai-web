/**
 * Modelos y tarifas publicadas por los proveedores (USD, noviembre de 2026).
 * ponytail: el costo se estima con esta tabla, no con la factura real; revisar las tarifas en fal.ai/pricing
 * y elevenlabs.io/pricing/api cuando cambien, o leer la facturación del proveedor si hace falta exactitud.
 */
export const MODELS = {
  image: { endpoint: 'fal-ai/nano-banana-2', editEndpoint: 'fal-ai/nano-banana-2/edit', usdPerImage: 0.08 },
  video: {
    // Prueba barata de un movimiento antes de pagar la toma final.
    draft: { endpoint: 'fal-ai/pixverse/v6/image-to-video', usdPerSecond: 0.025, durations: [5, 8, 10] },
    final: { endpoint: 'fal-ai/kling-video/v2.6/pro/image-to-video', usdPerSecond: 0.07, durations: [5, 10] },
  },
  speech: { model: 'eleven_multilingual_v2', usdPer1kChars: 0.08 },
  music: { model: 'music_v1', usdPerMinute: 0.15 },
  sfx: { model: 'eleven_text_to_sound_v2', usdPerMinute: 0.12 },
  // Revisión de video en movimiento. Esta tarifa de Gemini 3.8 Flash vale hasta el 31/dic/2026; después se duplica.
  review: { model: 'gemini-3.8-flash', usdPerMTokIn: 0.75, usdPerMTokOut: 3.75 },
} as const

export const PRICE_LIST = `Tarifas de generación vigentes, en USD:
- Imagen (${MODELS.image.endpoint}): ${MODELS.image.usdPerImage} por imagen.
- Video de prueba (${MODELS.video.draft.endpoint}, 360p): ${MODELS.video.draft.usdPerSecond} por segundo.
- Video final (${MODELS.video.final.endpoint}, sin audio): ${MODELS.video.final.usdPerSecond} por segundo, en clips de 5 o 10 segundos.
- Voz (ElevenLabs ${MODELS.speech.model}): ${MODELS.speech.usdPer1kChars} por mil caracteres.
- Música (ElevenLabs): ${MODELS.music.usdPerMinute} por minuto. Efectos de sonido: ${MODELS.sfx.usdPerMinute} por minuto.
- Revisión de video en movimiento (review_video): unos 0.01 a 0.03 por consulta sobre un clip corto.
- Montaje, color, mezcla, títulos y versiones: sin costo, se hacen en el servidor.`
