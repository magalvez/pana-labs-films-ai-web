import { randomBytes } from 'node:crypto'
import type { Db } from './engine/types.ts'

type Update = { update_id: number; message?: { chat: { id: number }; text?: string }; callback_query?: { id: string; data?: string; message?: { chat: { id: number } } } }
type Deps = {
  db: Db
  /** Clave del bot. Sin ella los avisos quedan apagados y nada falla. */
  token?: string
  username?: string
  /** Solo quien sigue teniendo acceso al estudio recibe avisos y puede decidir. */
  roleOf(email: string): Promise<string | null>
  /** `stage` es la etapa del aviso: si ya no es la que espera decisión, se rechaza. */
  approve(projectId: string, stage: string, email: string): Promise<string>
  sendBack(projectId: string, stage: string, email: string, comment: string): Promise<string>
  request?: typeof fetch
}

const CODE_MINUTES = 15
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Avisos por Telegram, enlazados por persona. El servidor pregunta a Telegram por mensajes nuevos (sondeo largo),
 * así funciona también en una máquina sin dirección pública.
 * ponytail: un solo proceso sondeando; desplegado en varios servidores habría que pasar a webhook.
 */
export function createTelegram({ db, token, username, roleOf, approve, sendBack, request = fetch }: Deps) {
  // Quien pulsó "Devolver" y debe escribir qué hay que corregir. Vive en memoria: tras un reinicio se pulsa otra vez.
  const awaiting = new Map<string, { projectId: string; stage: string; until: number }>()
  // En el .env suele escribirse con @; en el enlace t.me va sin ella.
  let bot = username?.trim().replace(/^@/, '') || undefined

  async function call(method: string, body: object, timeoutMs = 20_000): Promise<any> {
    // La dirección lleva la clave del bot: nunca se escribe en un error ni en un registro.
    const res = await request(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
    const json: any = await res.json().catch(() => ({}))
    if (!json.ok) throw Object.assign(new Error(`Telegram respondió ${res.status} en ${method}: ${json.description ?? 'sin detalle'}`), { status: res.status })
    return json.result
  }
  const say = (chat: string, text: string, buttons?: { text: string; callback_data: string }[]) =>
    call('sendMessage', { chat_id: chat, text, ...(buttons ? { reply_markup: { inline_keyboard: [buttons] } } : {}) }).catch((err) => console.error(err.message))

  async function botName() {
    if (!bot && token) bot = (await call('getMe', {})).username
    return bot
  }

  async function status(email: string) {
    const [row] = await db('SELECT chat_id FROM telegram_links WHERE email = ?', email)
    return { enabled: Boolean(token), linked: Boolean(row?.chat_id) }
  }

  /** Código de un solo uso y el enlace que abre el bot con él. */
  async function link(email: string) {
    if (!token) throw new Error('Los avisos por Telegram no están configurados en este servidor: falta TELEGRAM_BOT_TOKEN en el archivo .env')
    const code = randomBytes(6).toString('hex').toUpperCase()
    await db('INSERT INTO telegram_links (email, code, code_at) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET code = excluded.code, code_at = excluded.code_at', email, code, new Date().toISOString())
    return { code, link: `https://t.me/${await botName()}?start=${code}`, minutes: CODE_MINUTES }
  }
  const unlink = (email: string) => db('DELETE FROM telegram_links WHERE email = ?', email)

  /** Quién escribe desde ese chat, si sigue teniendo acceso al estudio. */
  async function who(chat: string) {
    const [row] = await db('SELECT email FROM telegram_links WHERE chat_id = ?', chat)
    return row && (await roleOf(row.email)) ? (row.email as string) : null
  }

  /** Aviso a todas las personas enlazadas. Con proyecto y etapa, lleva los botones para decidir esa etapa desde el chat. */
  async function notify(text: string, projectId?: string, stage?: string) {
    if (!token) return
    const rows = await db('SELECT email, chat_id FROM telegram_links WHERE chat_id IS NOT NULL')
    for (const r of rows) {
      if (!(await roleOf(r.email))) continue
      await say(r.chat_id, text, projectId && stage ? [{ text: 'Aprobar etapa', callback_data: `ok:${projectId}:${stage}` }, { text: 'Devolver', callback_data: `no:${projectId}:${stage}` }] : undefined)
    }
  }

  async function handle(u: Update) {
    const chat = String(u.message?.chat.id ?? u.callback_query?.message?.chat.id ?? '')
    if (!chat) return
    const text = u.message?.text?.trim() ?? ''
    const start = /^\/start\s+([A-F0-9]{12})$/i.exec(text)
    if (start) {
      const since = new Date(Date.now() - CODE_MINUTES * 60_000).toISOString()
      const [row] = await db('UPDATE telegram_links SET chat_id = ?, code = NULL, code_at = NULL WHERE code = ? AND code_at > ? RETURNING email', chat, start[1].toUpperCase(), since)
      return say(chat, row ? `Listo. Este chat queda enlazado a ${row.email} en Pana Films Lab: aquí te aviso cuando una producción te necesite.` : 'Ese código no existe o ya venció. Pide uno nuevo en Configuración.')
    }
    const email = await who(chat)
    if (!email) return say(chat, 'Este chat no está enlazado a ninguna cuenta de Pana Films Lab. Enlázalo desde Configuración, en "Avisos por Telegram".')
    if (u.callback_query) {
      const [, action, projectId, stage] = /^(ok|no):([\w-]{1,24}):([\w-]{1,30})$/.exec(u.callback_query.data ?? '') ?? []
      await call('answerCallbackQuery', { callback_query_id: u.callback_query.id }).catch(() => {})
      if (action === 'ok') return say(chat, await approve(projectId, stage, email).catch((err) => `No se pudo aprobar: ${err.message}`))
      if (action === 'no') { awaiting.set(chat, { projectId, stage, until: Date.now() + 10 * 60_000 }); return say(chat, 'Escribe en un solo mensaje qué hay que corregir y devuelvo la etapa completa. Para elegir agentes concretos, hazlo desde el estudio.') }
      return
    }
    const pending = awaiting.get(chat)
    if (pending && pending.until > Date.now() && text && !text.startsWith('/')) {
      awaiting.delete(chat)
      return say(chat, await sendBack(pending.projectId, pending.stage, email, text.slice(0, 5000)).catch((err) => `No se pudo devolver: ${err.message}`))
    }
    return say(chat, 'Aquí recibes los avisos de Pana Films Lab. Cuando una etapa espere decisión te llegará con sus botones.')
  }

  /** Sondeo largo. Un fallo de red o un choque con otro sondeo se reintenta; solo una clave inválida lo apaga. */
  async function start() {
    if (!token) return
    let offset = 0
    let warned = false
    for (;;) {
      try {
        const updates: Update[] = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 40_000)
        for (const u of updates) {
          offset = u.update_id + 1
          await handle(u).catch((err) => console.error(`Telegram: no se pudo atender un mensaje: ${err.message}`))
        }
      } catch (err: any) {
        if (err.status === 401) return console.error(`Avisos por Telegram apagados: ${err.message}. Revisa TELEGRAM_BOT_TOKEN.`)
        // Un 409 es normal unos segundos tras un reinicio (el sondeo anterior sigue abierto). Si persiste, otro servidor usa el mismo bot.
        if (err.status === 409 && !warned) { warned = true; console.error(`Telegram: ${err.message}. Se sigue intentando; si no para, otro servidor está usando este bot.`) }
        await sleep(err.status === 409 ? 30_000 : 5000)
      }
    }
  }

  return { status, link, unlink, notify, handle, start }
}

export type Telegram = ReturnType<typeof createTelegram>
