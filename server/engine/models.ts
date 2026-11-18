/** Tokens de una respuesta de Claude, con el modelo que la dio. Se guardan con cada costo para medir en vez de estimar. */
export type Usage = { model: string; input: number; cacheRead: number; cacheWrite: number; output: number }
type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }

export const DEFAULT_MODEL = 'claude-sonnet-5-5'

// USD por millón de tokens, de la documentación de Anthropic (noviembre de 2026). Actualizar si cambia la tarifa.
// Guardar en caché cuesta 1.25 veces la entrada. Releerla: 0.05 veces en Sonnet 5.5 y Opus 5.5.
// ponytail: para Haiku 5.5 la documentación solo da la regla general de lectura a 0.1 veces; confirmar contra la factura.
const haiku = (input: number, output: number): Price => ({ input, output, cacheRead: input * 0.1, cacheWrite: input * 1.25 })
export const MODELS: Record<string, { name: string; note: string; price(promptTokens: number): Price }> = {
  'claude-haiku-5-5': { name: 'Haiku 5.5', note: 'El más barato y rápido. Para leer y escribir texto sin decisiones delicadas.', price: (prompt) => (prompt <= 100_000 ? haiku(0.1, 0.5) : haiku(0.5, 2.5)) },
  'claude-sonnet-5-5': { name: 'Sonnet 5.5', note: 'El equilibrado. Es el que usa todo el estudio por defecto.', price: () => ({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }) },
  'claude-opus-5-5': { name: 'Opus 5.5', note: 'El más capaz y el doble de caro que Sonnet. Para el guion y las decisiones que arrastran a todo lo demás.', price: () => ({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }) },
}

/** Lo que costó una respuesta, separado por tipo de token. */
export function usdByKind(u: Usage) {
  const p = (Object.hasOwn(MODELS, u.model) ? MODELS[u.model] : MODELS[DEFAULT_MODEL]).price(u.input + u.cacheRead + u.cacheWrite)
  return { input: (u.input * p.input) / 1e6, cacheRead: (u.cacheRead * p.cacheRead) / 1e6, cacheWrite: (u.cacheWrite * p.cacheWrite) / 1e6, output: (u.output * p.output) / 1e6 }
}
export const usdOf = (u: Usage) => Object.values(usdByKind(u)).reduce((a, b) => a + b, 0)

/** Sugerencia del estudio, no el valor por defecto: quien no aparece aquí se queda en el modelo por defecto. */
export const RECOMMENDED: Record<string, string> = {
  'story-architect': 'claude-opus-5-5',
  ...Object.fromEntries(['brand-market-research', 'legal-compliance', 'producer-budget', 'localization', 'versioning', 'disclosure-metadata', 'delivery', 'performance-analyst'].map((id) => [id, 'claude-haiku-5-5'])),
}
