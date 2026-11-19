import { randomBytes } from 'node:crypto'
import type { Db } from './engine/types.ts'

type Update = { update_id: number; message?: { chat: { id: number }; text?: string }; callback_query?: { id: string; data?: string; message?: { message_id?: number; chat: { id: number } } } }
type Role = 'admin' | 'member'
type Btn = { text: string; callback_data: string }
type Msg = { text: string; keys?: Btn[][] }

/** Una producción tal como la muestra el bot: dónde va, cuánto lleva gastado y qué etapa espera. */
export type Card = {
  id: string; name: string; status: string; reason: string | null; spent: number; cap: number
  /** Posición de la etapa actual; igual al número de etapas cuando ya se entregó. */
  at: number
  stage: { id: string; name: string; gate: string } | null
  stages: { id: string; label: string; name: string }[]
}
type Note = { id: string; kind: string; about: string; name: string; text: string }
/** Lo que el bot necesita del estudio. Lo implementa `createStudio` sobre el motor. */
export type Studio = {
  /** Solo quien sigue teniendo acceso al estudio recibe avisos y puede decidir. */
  roleOf(email: string): Promise<Role | null>
  card(id: string): Promise<Card>
  list(): Promise<Card[]>
  /** Último veredicto del auditor sobre la etapa actual. */
  audit(id: string): Promise<{ approved: boolean; attempt: number; issues: string[]; agents: number; files: number } | null>
  delivered(id: string): Promise<{ agent: string; version: number; files: string[] }[]>
  summary(id: string): Promise<{ minutes: number; reworks: number; totalUsd: number; modelUsd: number; generationUsd: number; reworkUsd: number; byStage: { name: string; usd: number }[] }>
  /** `stage` es la etapa del aviso: si ya no es la que espera decisión, se rechaza con `stale`. */
  approve(id: string, stage: string, email: string): Promise<void>
  sendBack(id: string, stage: string, email: string, comment: string): Promise<void>
  raise(id: string, extra: number): Promise<Card>
  cancel(id: string): Promise<unknown>
  retry(id: string): Promise<unknown>
  improve(id: string, stage: string, text: string, budget: number, email: string): Promise<unknown>
  note(id: string, noteId: string): Promise<Note | null>
  resolve(id: string, noteId: string, status: 'used' | 'dismissed'): Promise<void>
}
type Deps = {
  db: Db
  /** Clave del bot. Sin ella los avisos quedan apagados y nada falla. */
  token?: string
  username?: string
  studio: Studio
  request?: typeof fetch
}
/** Lo que el bot espera que la persona escriba a continuación. Vive en memoria: tras un reinicio se pulsa otra vez. */
type Pending = { kind: 'back' | 'improve'; projectId: string; stage: string; text?: string; msg?: number; until: number }

const CODE_MINUTES = 15, WAIT_MS = 10 * 60_000
const RAISES = [10, 25, 50], IMPROVE = [5, 10, 25]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- diseño de los mensajes (HTML de Telegram)
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const usd = (n: number) => `$${n.toFixed(2)}`
const head = (c: Card) => `🎬 <b>${esc(c.name)}</b>`
const bar = (c: Card) => { const n = Math.max(0, Math.min(10, Math.round((c.spent / (c.cap || 1)) * 10))); return `💰 ${'▰'.repeat(n)}${'▱'.repeat(10 - n)}  <b>${usd(c.spent)}</b> de ${usd(c.cap)}` }
const track = (c: Card, mark: string) => c.stages.map((s, i) => `${i < c.at ? '✅' : i === c.at ? mark : '⚪️'} ${s.label}`).join('  ')
const quote = (s: string) => `<blockquote>${esc(s)}</blockquote>`
const clock = () => new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
const lasted = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`)
const ICON: Record<string, string> = { waiting_human: '🟡', running: '▶️', paused: '⏸', failed: '🛑', done: '🏁', exploring: '🎨', cancelled: '✖️' }
const STATE: Record<string, string> = { waiting_human: 'espera tu aprobación', running: 'en marcha', paused: 'en pausa', failed: 'detenida', done: 'entregado', exploring: 'explorando el look', cancelled: 'cancelada' }

/**
 * Avisos por Telegram, enlazados por persona. El servidor pregunta a Telegram por mensajes nuevos (sondeo largo),
 * así funciona también en una máquina sin dirección pública.
 * ponytail: un solo proceso sondeando; desplegado en varios servidores habría que pasar a webhook.
 */
export function createTelegram({ db, token, username, studio, request = fetch }: Deps) {
  const awaiting = new Map<string, Pending>()
  // En el .env suele escribirse con @; en el enlace t.me va sin ella.
  let bot = username?.trim().replace(/^@/, '') || undefined

  async function call(method: string, body: object, timeoutMs = 20_000): Promise<any> {
    // La dirección lleva la clave del bot: nunca se escribe en un error ni en un registro.
    const res = await request(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
    const json: any = await res.json().catch(() => ({}))
    if (!json.ok) throw Object.assign(new Error(`Telegram respondió ${res.status} en ${method}: ${json.description ?? 'sin detalle'}`), { status: res.status })
    return json.result
  }
  const markup = (keys?: Btn[][]) => ({ reply_markup: { inline_keyboard: keys ?? [] } })
  const say = (chat: string, m: Msg | string) => {
    const msg = typeof m === 'string' ? { text: m } : m
    return call('sendMessage', { chat_id: chat, text: msg.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(msg.keys ? markup(msg.keys) : {}) }).catch((err) => console.error(err.message))
  }
  /** Reescribe un aviso ya enviado: así el resultado queda en el mismo mensaje y no sobran botones viejos. */
  const edit = (chat: string, id: number | undefined, m: Msg) =>
    id ? call('editMessageText', { chat_id: chat, message_id: id, text: m.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...markup(m.keys) }).catch((err) => console.error(err.message)) : say(chat, m)
  const keysOnly = (chat: string, id: number | undefined, keys?: Btn[][]) => (id ? call('editMessageReplyMarkup', { chat_id: chat, message_id: id, ...markup(keys) }).catch(() => {}) : undefined)

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

  /** Quién escribe desde ese chat y con qué rol, si sigue teniendo acceso al estudio. */
  async function who(chat: string) {
    const [row] = await db('SELECT email FROM telegram_links WHERE chat_id = ?', chat)
    const role = row ? await studio.roleOf(row.email) : null
    return role ? { email: row.email as string, role } : null
  }

  // ---------------------------------------------------------------- mensajes
  async function gate(c: Card): Promise<Msg> {
    const a = await studio.audit(c.id), stage = c.stage!, escalated = c.reason === 'escalated'
    const said = !a ? '' : escalated || !a.approved
      ? `🕵️ Auditor: ${a.issues.join(' · ') || 'no dio detalle.'}`
      : `🕵️ Auditor: aprobó ${a.attempt === 1 ? 'al primer intento' : `al intento ${a.attempt}`}. ${a.agents} agentes entregaron ${a.files} archivos.`
    const title = escalated
      ? `🚨 <b>${esc(stage.name)} necesita tu decisión</b>\n<i>El auditor la rechazó${a ? ` ${a.attempt} veces` : ' varias veces'}</i>`
      : `🟡 <b>${esc(stage.name)} espera tu aprobación</b>\n<i>${esc(stage.gate)}</i>`
    return {
      text: `${head(c)}\n\n${title}\n\n${track(c, escalated ? '🔴' : '🟡')}\n\n${said ? quote(said) + '\n' : ''}${bar(c)}`,
      keys: [[{ text: escalated ? '✅ Aprobar así' : '✅ Aprobar etapa', callback_data: `ok:${c.id}:${stage.id}` }, { text: '↩️ Devolver', callback_data: `no:${c.id}:${stage.id}` }], [{ text: '📋 Ver qué entregaron', callback_data: `ver:${c.id}` }]],
    }
  }
  /** El aviso que corresponde al estado actual de una producción. Las acciones de dinero solo las ve un administrador. */
  async function stateMsg(c: Card, role: Role): Promise<Msg> {
    const admin = role === 'admin'
    if (c.status === 'waiting_human' && c.stage) return gate(c)
    if (c.status === 'paused' && c.reason === 'budget') return {
      text: `${head(c)}\n\n⏸ <b>En pausa: alcanzó el tope</b>\n\n${track(c, '⏸')}\n\n${bar(c)}\n\nNo se perdió nada. ${admin ? 'Sube el tope y sigue donde quedó.' : 'Pídele a un administrador que suba el tope.'}`,
      keys: admin ? [RAISES.map((n) => ({ text: `➕ $${n}`, callback_data: `up:${c.id}:${n}` })), [{ text: '✖️ Cancelar producción', callback_data: `cx:${c.id}` }]] : undefined,
    }
    if (c.status === 'paused') return { text: `${head(c)}\n\n⏸ <b>En pausa</b>\n\n${track(c, '⏸')}\n\n${bar(c)}`, keys: [[{ text: '▶️ Reanudar', callback_data: `re:${c.id}` }]] }
    if (c.status === 'failed') return { text: `${head(c)}\n\n🛑 <b>La producción se detuvo</b>\n\n${track(c, '🛑')}\n\n${quote(c.reason ?? 'Error sin detalle.')}\nCorrige la causa y vuelve a intentarlo.`, keys: [[{ text: '🔁 Reintentar', callback_data: `re:${c.id}` }]] }
    if (c.status === 'done') {
      const s = await studio.summary(c.id)
      return {
        text: `${head(c)}\n\n🏁 <b>¡Comercial entregado!</b>\n\n${track(c, '✅')}\n\n${bar(c)}\n⏱ ${lasted(s.minutes)}  ·  🔁 ${s.reworks} ${s.reworks === 1 ? 'repetición' : 'repeticiones'}`,
        keys: [[{ text: '📊 Ver costos', callback_data: `co:${c.id}` }, ...(admin ? [{ text: '✨ Pedir una mejora', callback_data: `im:${c.id}` }] : [])]],
      }
    }
    if (c.status === 'exploring') return { text: `${head(c)}\n\n🎨 <b>Explorando el look</b>\nTodavía no arranca la producción.\n\n${bar(c)}` }
    if (c.status === 'cancelled') return { text: `${head(c)}\n\n✖️ <b>Producción cancelada</b>\n\n${bar(c)}` }
    return { text: `${head(c)}\n\n▶️ <b>${esc(c.stage?.name ?? 'La producción')} en marcha</b>\n\n${track(c, '▶️')}\n\n${bar(c)}` }
  }
  function noteMsg(c: Card, n: Note): Msg {
    const what = n.about === 'moodboard' ? 'el moodboard' : 'la pieza', name = esc(n.name || 'El cliente')
    if (n.kind === 'approve') return { text: `${head(c)}\n\n👍 <b>${name} aprobó ${what}</b>${n.text ? `\n${quote(`«${n.text}»`)}` : ''}` }
    return { text: `${head(c)}\n\n💬 <b>${name} comentó ${what}</b>\n${quote(`«${n.text}»`)}`, keys: n.id ? [[{ text: '🛠 Usar como corrección', callback_data: `fu:${c.id}:${n.id}` }, { text: '🗑 Descartar', callback_data: `fd:${c.id}:${n.id}` }]] : undefined }
  }
  async function listMsg(): Promise<Msg> {
    const cards = await studio.list()
    if (!cards.length) return { text: '📽 <b>Tus producciones</b>\n\nTodavía no hay ninguna. Crea la primera desde el estudio.' }
    const lines = cards.map((c) => `${ICON[c.status] ?? '▫️'} <b>${esc(c.name)}</b> · ${STATE[c.status] ?? c.status}\n      ${c.stage && c.status !== 'done' ? `${esc(c.stage.name)} · ` : ''}${usd(c.spent)} de ${usd(c.cap)}`)
    return { text: `📽 <b>Tus producciones</b>\n<i>Escribe /estado cuando quieras verlas</i>\n\n${lines.join('\n')}`, keys: cards.slice(0, 6).map((c) => [{ text: `${ICON[c.status] ?? '▫️'} ${c.name.slice(0, 40)}`, callback_data: `st:${c.id}` }]) }
  }
  const oops = (err: any): Msg => ({ text: err?.stale ? `⚠️ <b>Ese aviso ya no vale</b>\n${esc(err.message)}` : `⚠️ <b>No se pudo</b>\n${esc(String(err?.message ?? err))}` })
  const cancelKey: Btn[][] = [[{ text: '✖️ Cancelar', callback_data: 'x' }]]
  const budgetKeys = (id: string): Btn[][] => [IMPROVE.map((n) => ({ text: `$${n}`, callback_data: `ib:${id}:${n}` })), cancelKey[0]]

  /** Aviso a todas las personas enlazadas: el estado actual de la producción o, con `note`, la opinión del cliente. */
  async function announce(projectId: string, note?: Note) {
    if (!token) return
    const rows = await db('SELECT email, chat_id FROM telegram_links WHERE chat_id IS NOT NULL')
    const card = await studio.card(projectId)
    for (const r of rows) {
      const role = await studio.roleOf(r.email)
      if (role) await say(r.chat_id, note ? noteMsg(card, note) : await stateMsg(card, role))
    }
  }

  /** Un botón pulsado. Devuelve lo que hay que mostrar; lo que cambia un aviso existente lo reescribe ahí mismo. */
  async function press(chat: string, me: { email: string; role: Role }, data: string, msg: number | undefined) {
    const [action, id = '', arg = ''] = data.split(':')
    const adminOnly = () => { if (me.role !== 'admin') throw new Error('Esto solo lo puede hacer un administrador.') }
    if (action === 'x') { awaiting.delete(chat); return edit(chat, msg, { text: '✖️ Cancelado.' }) }
    if (action === 'ls') return say(chat, await listMsg())
    if (!/^[\w-]{1,24}$/.test(id) || !/^[\w-]{0,30}$/.test(arg)) return
    if (action === 'st') return say(chat, await stateMsg(await studio.card(id), me.role))
    if (action === 'ok') {
      const before = await studio.card(id)
      try { await studio.approve(id, arg, me.email) } catch (err: any) { if (err?.stale) await keysOnly(chat, msg); throw err }
      const c = await studio.card(id), name = before.stages.find((s) => s.id === arg)?.name ?? 'La etapa'
      return edit(chat, msg, { text: `${head(c)}\n\n✅ <b>${esc(name)} aprobada</b>\n<i>Por ti, desde Telegram · ${clock()}</i>\n\n${track(c, '▶️')}\n\n${c.status === 'done' ? 'Era la última etapa.' : `${esc(c.stage?.name ?? 'La siguiente etapa')} ya está en marcha.`}` })
    }
    if (action === 'no') {
      const c = await studio.card(id), name = c.stages.find((s) => s.id === arg)?.name ?? 'la etapa'
      awaiting.set(chat, { kind: 'back', projectId: id, stage: arg, msg, until: Date.now() + WAIT_MS })
      return say(chat, { text: `${head(c)}\n\n↩️ <b>¿Qué hay que corregir en ${esc(name)}?</b>\nEscribe la indicación en un solo mensaje.\n\n<i>Ejemplo: «El producto debe verse en el plano 3».</i>\n<i>Para elegir agentes concretos, hazlo desde el estudio.</i>`, keys: cancelKey })
    }
    if (action === 'ver') {
      const [c, list, a] = await Promise.all([studio.card(id), studio.delivered(id), studio.audit(id)])
      const lines = list.map((d) => `• <b>${esc(d.agent)}</b>${d.version > 1 ? ` (versión ${d.version})` : ''}\n   ${esc(d.files.join(', '))}`)
      return say(chat, `${head(c)}\n\n📋 <b>${esc(c.stage?.name ?? 'Etapa')}: qué entregaron</b>\n\n${lines.join('\n') || 'Todavía no hay entregas.'}${a ? `\n\n${quote(`🕵️ Auditor: ${a.approved ? 'aprobado' : 'rechazado'} en el intento ${a.attempt}.${a.issues.length ? ' ' + a.issues.join(' · ') : ''}`)}` : ''}\n<i>Los archivos se abren desde el estudio.</i>`)
    }
    if (action === 'up') {
      adminOnly()
      const extra = Number(arg)
      if (!RAISES.includes(extra)) return
      const c = await studio.raise(id, extra)
      return edit(chat, msg, { text: `${head(c)}\n\n✅ <b>Tope subido a ${usd(c.cap)}</b>\n<i>Por ti, desde Telegram · ${clock()}</i>\n\n${track(c, '▶️')}\n\n${bar(c)}\n\nLa producción sigue donde quedó.` })
    }
    // Cancelar no se deshace: pide una segunda pulsación.
    if (action === 'cx') { adminOnly(); return keysOnly(chat, msg, [[{ text: '⚠️ Sí, cancelar', callback_data: `cy:${id}` }, { text: 'No, seguir', callback_data: `cn:${id}` }]]) }
    if (action === 'cn') return edit(chat, msg, await stateMsg(await studio.card(id), me.role))
    if (action === 'cy') { adminOnly(); await studio.cancel(id); return edit(chat, msg, await stateMsg(await studio.card(id), me.role)) }
    if (action === 're') { await studio.retry(id); const c = await studio.card(id); return edit(chat, msg, { text: `${head(c)}\n\n▶️ <b>De nuevo en marcha</b>\n<i>Por ti, desde Telegram · ${clock()}</i>\n\n${track(c, '▶️')}\n\n${bar(c)}` }) }
    if (action === 'co') {
      const [c, s] = await Promise.all([studio.card(id), studio.summary(id)])
      return say(chat, `${head(c)}\n\n📊 <b>Costos</b>\n\n${s.byStage.map((x) => `• ${esc(x.name)}: <b>${usd(x.usd)}</b>`).join('\n')}\n\n🧠 Claude ${usd(s.modelUsd)}  ·  🎞 Generación ${usd(s.generationUsd)}\n🔁 En repeticiones: ${usd(s.reworkUsd)}\n\n${bar(c)}`)
    }
    if (action === 'im') {
      adminOnly()
      const c = await studio.card(id)
      return say(chat, { text: `${head(c)}\n\n✨ <b>¿En qué etapa está el cambio?</b>\nSe rehace esa etapa y las siguientes; lo anterior no se toca.`, keys: [...c.stages.map((s) => [{ text: s.name, callback_data: `is:${id}:${s.id}` }]), cancelKey[0]] })
    }
    if (action === 'is') {
      adminOnly()
      const c = await studio.card(id), name = c.stages.find((s) => s.id === arg)?.name ?? 'la etapa'
      // Si la mejora nació de un comentario del cliente, el texto ya está: solo falta el tope.
      const text = awaiting.get(chat)?.kind === 'improve' && awaiting.get(chat)!.projectId === id ? awaiting.get(chat)!.text : undefined
      awaiting.set(chat, { kind: 'improve', projectId: id, stage: arg, text, until: Date.now() + WAIT_MS })
      if (text) return edit(chat, msg, { text: `${head(c)}\n\n✨ <b>Mejora en ${esc(name)}</b>\n${quote(text)}\n¿Cuánto se puede gastar en esta mejora? Se suma al tope.`, keys: budgetKeys(id) })
      return edit(chat, msg, { text: `${head(c)}\n\n✨ <b>¿Qué hay que mejorar en ${esc(name)}?</b>\nDescríbelo en un solo mensaje.`, keys: cancelKey })
    }
    if (action === 'ib') {
      adminOnly()
      const p = awaiting.get(chat), budget = Number(arg)
      if (!p || p.kind !== 'improve' || p.projectId !== id || !p.text || p.until < Date.now() || !IMPROVE.includes(budget)) return edit(chat, msg, { text: '⚠️ <b>Esa mejora ya venció</b>\nPídela de nuevo desde el aviso de entrega.' })
      awaiting.delete(chat)
      await studio.improve(id, p.stage, p.text, budget, me.email)
      const c = await studio.card(id)
      return edit(chat, msg, { text: `${head(c)}\n\n✨ <b>Mejora en marcha</b>\n${quote(p.text)}\nEl tope sube ${usd(budget)}. Te aviso cuando la etapa vuelva a estar lista.` })
    }
    if (action === 'fu' || action === 'fd') {
      const [c, n] = await Promise.all([studio.card(id), studio.note(id, arg)])
      if (!n) return edit(chat, msg, { text: '⚠️ <b>Ese comentario ya no existe</b>' })
      const base = noteMsg(c, n).text
      if (action === 'fd') { await studio.resolve(id, n.id, 'dismissed'); return edit(chat, msg, { text: `${base}\n\n🗑 <i>Descartado · ${clock()}</i>` }) }
      if (c.status === 'waiting_human' && c.stage) {
        await studio.sendBack(id, c.stage.id, me.email, n.text)
        await studio.resolve(id, n.id, 'used')
        return edit(chat, msg, { text: `${base}\n\n🛠 <i>Usado para devolver ${esc(c.stage.name)} · ${clock()}</i>` })
      }
      if (c.status === 'done') {
        adminOnly()
        await studio.resolve(id, n.id, 'used')
        awaiting.set(chat, { kind: 'improve', projectId: id, stage: '', text: n.text, until: Date.now() + WAIT_MS })
        await edit(chat, msg, { text: `${base}\n\n🛠 <i>Usado para pedir una mejora · ${clock()}</i>` })
        return say(chat, { text: `${head(c)}\n\n✨ <b>¿En qué etapa está el cambio?</b>\nSe rehace esa etapa y las siguientes; lo anterior no se toca.`, keys: [...c.stages.map((s) => [{ text: s.name, callback_data: `is:${id}:${s.id}` }]), cancelKey[0]] })
      }
      throw new Error('Ahora no hay dónde usarlo: la producción no está esperando una decisión ni entregada. Queda guardado en el estudio.')
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
      if (!row) return say(chat, '⚠️ <b>Ese código no existe o ya venció</b>\nPide uno nuevo en Configuración.')
      return say(chat, { text: `🔗 <b>¡Chat enlazado!</b>\nQueda unido a <code>${esc(row.email)}</code> en Pana Films Lab.\n\nAquí te aviso cuando:\n🟡 una etapa espere tu aprobación\n⏸ se alcance el tope de presupuesto\n🛑 algo se detenga\n🏁 se entregue un comercial\n💬 un cliente opine`, keys: [[{ text: '📽 Ver mis producciones', callback_data: 'ls' }]] })
    }
    const me = await who(chat)
    if (!me) {
      if (u.callback_query) await call('answerCallbackQuery', { callback_query_id: u.callback_query.id }).catch(() => {})
      return say(chat, '🔒 <b>Este chat no está enlazado</b>\nEnlázalo desde Configuración, en «Avisos por Telegram».')
    }
    if (u.callback_query) {
      await call('answerCallbackQuery', { callback_query_id: u.callback_query.id }).catch(() => {})
      return press(chat, me, u.callback_query.data ?? '', u.callback_query.message?.message_id).catch((err) => say(chat, oops(err)))
    }
    if (/^\/(estado|start|producciones)\b/i.test(text)) return say(chat, await listMsg())
    const p = awaiting.get(chat)
    if (p && p.until > Date.now() && text && !text.startsWith('/')) {
      const words = text.slice(0, 5000)
      try {
        const c = await studio.card(p.projectId)
        if (p.kind === 'back') {
          awaiting.delete(chat)
          await studio.sendBack(p.projectId, p.stage, me.email, words)
          await keysOnly(chat, p.msg)
          const name = c.stages.find((s) => s.id === p.stage)?.name ?? 'La etapa'
          return say(chat, `${head(c)}\n\n↩️ <b>${esc(name)} devuelta</b>\n${quote(`«${words}»`)}\nToda la etapa se está rehaciendo. Te aviso cuando vuelva a estar lista.`)
        }
        if (!p.stage) return say(chat, 'Primero elige la etapa con los botones de arriba.')
        if (words.length < 10) return say(chat, 'Descríbelo con un poco más de detalle, en un solo mensaje.')
        awaiting.set(chat, { ...p, text: words, until: Date.now() + WAIT_MS })
        return say(chat, { text: `${head(c)}\n\n✨ <b>Mejora en ${esc(c.stages.find((s) => s.id === p.stage)?.name ?? 'la etapa')}</b>\n${quote(words)}\n¿Cuánto se puede gastar en esta mejora? Se suma al tope.`, keys: budgetKeys(p.projectId) })
      } catch (err) { return say(chat, oops(err)) }
    }
    return say(chat, { text: '👋 <b>Pana Films Lab</b>\nAquí recibes los avisos del estudio. Cuando una etapa espere decisión te llegará con sus botones.', keys: [[{ text: '📽 Ver mis producciones', callback_data: 'ls' }]] })
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

  return { status, link, unlink, announce, handle, start }
}

export type Telegram = ReturnType<typeof createTelegram>
