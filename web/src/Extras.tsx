import qrcode from 'qrcode-generator'
import { useEffect, useState } from 'react'
import { api } from './api'
import type { SchemeT } from './office/world'

type Act = (fn: () => Promise<unknown>) => Promise<boolean>
const usd = (n: number) => `$${n.toFixed(2)}`
const day = (ts: string) => new Date(ts).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' })

/** Enlace del chat de Telegram de quien tiene la sesión abierta. Cada persona enlaza el suyo. */
/** Código QR dibujado aquí mismo: el enlace lleva un código personal y no se manda a ningún servicio externo. */
function Qr({ text }: { text: string }) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  let d = ''
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`
  // Siempre negro sobre blanco, con margen: así lo lee cualquier cámara aunque el estudio esté en oscuro.
  return <svg className="tg-qr" role="img" aria-label="Código QR para abrir el bot de Telegram en tu celular" viewBox={`-4 -4 ${n + 8} ${n + 8}`} shapeRendering="crispEdges"><rect x={-4} y={-4} width={n + 8} height={n + 8} fill="#fff" /><path d={d} fill="#000" /></svg>
}

export function TelegramLink({ act }: { act: Act }) {
  const [state, setState] = useState<{ enabled: boolean; linked: boolean } | null>(null)
  const [pass, setPass] = useState<{ code: string; link: string; minutes: number } | null>(null)
  const load = () => act(async () => setState(await api('/telegram')))
  useEffect(() => { void load() }, [])
  // Mientras hay un código pendiente se consulta si ya se usó, para confirmar el enlace sin recargar.
  useEffect(() => {
    if (!pass || state?.linked) return
    const timer = window.setInterval(() => api<{ enabled: boolean; linked: boolean }>('/telegram').then((s) => { setState(s); if (s.linked) setPass(null) }).catch(() => {}), 3000)
    return () => clearInterval(timer)
  }, [pass, state?.linked])
  return (
    <section className="credits" aria-label="Avisos por Telegram">
      <h3>Avisos por Telegram</h3>
      {!state ? <p className="note">Consultando…</p> : !state.enabled ? (
        <p className="note">Este servidor no tiene bot de Telegram. Quien administra el servidor debe crear uno con @BotFather y poner <code>TELEGRAM_BOT_TOKEN</code> en el archivo <code>.env</code>.</p>
      ) : state.linked ? (
        <>
          <p><strong>Tu Telegram está enlazado.</strong> Te avisamos cuando una etapa espera decisión, cuando una producción alcanza su tope, se detiene o se entrega, y cuando un cliente opina. Desde el chat puedes aprobar o devolver una etapa.</p>
          <p><button onClick={() => act(async () => { setState(await api('/telegram/unlink', 'POST', {})); setPass(null) })}>Desenlazar mi Telegram</button></p>
        </>
      ) : pass ? (
        <>
          <p><strong>Escanea el código con la cámara del celular y pulsa «Iniciar» en Telegram.</strong> Vale {pass.minutes} minutos y una sola vez.</p>
          <Qr text={pass.link} />
          <p role="status" className="note tg-waiting">Esperando a que pulses «Iniciar»…</p>
          <p>¿Telegram en este computador? <a className="tg-open" href={pass.link} target="_blank" rel="noreferrer">Abrir Telegram</a></p>
          <p className="note">Si el botón no abre la app, escribe al bot este mensaje: <code>/start {pass.code}</code>. Esta pantalla se actualiza sola cuando quede enlazado.</p>
        </>
      ) : (
        <>
          <p>Recibe en tu Telegram los avisos del estudio y decide las etapas desde el chat. El enlace es personal: cada cuenta enlaza el suyo.</p>
          <p><button className="primary" onClick={() => act(async () => setPass(await api('/telegram/link', 'POST', {})))}>Enlazar mi Telegram</button></p>
        </>
      )}
    </section>
  )
}

const REGRESSION = 'Regresión'
const BRIEF = `Comercial de 15 segundos para redes, formato horizontal 16:9, en español.
Marca: Café Aurora, café de especialidad colombiano tostado en pequeños lotes.
Producto: bolsa de 340 g de café en grano, tueste medio.
Público: personas de 25 a 40 años que trabajan desde casa.
Objetivo: que prueben el café comprando en la tienda en línea.
Idea: una mañana cualquiera se vuelve especial con la primera taza.
Tono: cálido, tranquilo, luz de mañana. Una sola protagonista, una sola locación (cocina).
Estructura: 4 planos. Cierre con el nombre de la marca y el lema "Empieza despacio".
Voz en off femenina, una sola frase. Sin diálogo a cámara.`
type Row = { id: string; name: string; status: string; spent: number; runs: number; reworks: number; simulation: boolean; created_at: string; last_activity: string | null }

/** El mismo brief, corrido tras cambiar instrucciones o modelos, para ver si el estudio mejora o empeora. */
export function Regression({ act, budget }: { act: Act; budget: number }) {
  const [rows, setRows] = useState<Row[]>([])
  const [cap, setCap] = useState(Math.min(budget, 30))
  const load = () => act(async () => setRows((await api<Row[]>('/admin/projects')).filter((r) => r.name.startsWith(REGRESSION))))
  useEffect(() => { void load() }, [])
  const minutes = (r: Row) => (r.last_activity ? Math.round((new Date(r.last_activity).getTime() - new Date(r.created_at).getTime()) / 60_000) : 0)
  return (
    <section className="credits models" aria-label="Corrida de regresión">
      <h3>Corrida de regresión</h3>
      <p className="note">Un comercial fijo de 15 segundos y 4 planos. Córrelo después de cambiar instrucciones o modelos y compara costo, repeticiones y tiempo con las corridas anteriores. Usa el modo que esté activo arriba: en modo real gasta dinero, hasta el tope que pongas.</p>
      <p className="model-actions">
        <label>Tope en dólares <input type="number" min={1} max={10000} step={1} value={cap} onChange={(e) => setCap(Number(e.target.value))} /></label>
        <button onClick={() => act(async () => { await api('/projects', 'POST', { name: `${REGRESSION} ${new Date().toLocaleDateString('es', { day: '2-digit', month: 'short' })} ${new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`, brief: BRIEF, budgetCap: cap }); await load() })}>Crear corrida de regresión</button>
      </p>
      {rows.length > 0 && (
        <table>
          <thead><tr><th scope="col">Corrida</th><th scope="col">Modo</th><th scope="col">Estado</th><th scope="col">Costo</th><th scope="col">Ejecuciones</th><th scope="col">Repeticiones</th><th scope="col">Minutos</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><th scope="row">{r.name.slice(REGRESSION.length).trim() || day(r.created_at)}</th><td>{r.simulation ? 'Simulación' : 'Real'}</td><td>{r.status === 'done' ? 'Entregada' : 'En curso o detenida'}</td><td>{usd(r.spent)}</td><td>{r.runs}</td><td>{r.reworks}</td><td>{minutes(r)}</td></tr>)}</tbody>
        </table>
      )}
    </section>
  )
}

/** Con la pieza entregada: pedir una mejora al auditor de una etapa, que la reparte entre sus agentes. */
export function Improve({ scheme, spent, draft, post }: { scheme: SchemeT; spent: number; draft: string; post: (path: string, body?: unknown) => Promise<boolean> }) {
  const [open, setOpen] = useState(false)
  const [stage, setStage] = useState(scheme.stages.at(-2)?.id ?? scheme.stages[0].id)
  const [text, setText] = useState('')
  const [budget, setBudget] = useState(10)
  const [sending, setSending] = useState(false)
  // Un comentario del cliente que se quiere usar llega ya escrito.
  useEffect(() => { if (draft) { setText(draft); setOpen(true) } }, [draft])
  if (!open) return <button onClick={() => setOpen(true)}>Pedir una mejora</button>
  const chosen = scheme.stages.find((s) => s.id === stage)!
  const later = scheme.stages.slice(scheme.stages.indexOf(chosen) + 1).map((s) => s.name)
  return (
    <div className="improve">
      <h3>Pedir una mejora</h3>
      <label>A qué auditor se la pides
        <select value={stage} onChange={(e) => setStage(e.target.value)}>{scheme.stages.map((s) => <option key={s.id} value={s.id}>{s.auditor.name}: {s.name}</option>)}</select>
      </label>
      <label>Qué quieres mejorar
        <textarea rows={3} maxLength={5000} value={text} placeholder="Por ejemplo: en el plano 2 la taza debe verse de frente y con más vapor" onChange={(e) => setText(e.target.value)} />
      </label>
      <label>Cuánto se puede gastar en esta mejora, en dólares
        <input type="number" min={1} max={10000} step={1} value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
      </label>
      <p className="note">El {chosen.auditor.name} decide qué agentes de su etapa rehacen qué. {later.length ? `Después se actualizan ${later.join(', ')}, y cada etapa reabierta vuelve a pasar por su auditor y por tu aprobación.` : 'Esa etapa vuelve a pasar por su auditor y por tu aprobación.'} La versión entregada se conserva. Van {usd(spent)} gastados; el tope sube en lo que autorices aquí.</p>
      <p className="improve-actions">
        <button onClick={() => setOpen(false)}>Cancelar</button>
        <button className="primary" disabled={sending || text.trim().length < 10 || !(budget > 0)} onClick={() => { setSending(true); void post('improve', { stage, text, budget }).then((ok) => { if (ok) { setOpen(false); setText('') } }).finally(() => setSending(false)) }}>{sending ? 'Enviando…' : 'Enviar al auditor'}</button>
      </p>
    </div>
  )
}

type Note = { id: string; at: string; kind: 'approve' | 'comment'; about: string; target: string; name: string; text: string; status: 'new' | 'used' | 'dismissed' }

/** Lo que el cliente aprobó o comentó desde su enlace. Nada pasa a los agentes hasta que alguien del estudio lo decide. */
export function ClientNotes({ pid, act, refresh, onUse }: { pid: string; act: Act; refresh: number; onUse?: (text: string) => void }) {
  const [notes, setNotes] = useState<Note[]>([])
  useEffect(() => { setNotes([]); api<Note[]>(`/projects/${pid}/feedback`).then(setNotes).catch(() => {}) }, [pid, refresh])
  const mark = (n: Note, status: 'used' | 'dismissed') => act(async () => setNotes(await api<Note[]>(`/projects/${pid}/feedback/${n.id}`, 'POST', { status })))
  const fresh = notes.filter((n) => n.status === 'new')
  if (!fresh.length) return null
  return (
    <section className="client-notes" aria-label="Opinión del cliente">
      <h3>El cliente opinó</h3>
      <ul>{fresh.map((n) => (
        <li key={n.id} className={n.kind}>
          <p><strong>{n.name || 'Cliente'}</strong> {n.kind === 'approve' ? 'aprobó' : 'comentó'} {n.about === 'moodboard' ? 'el moodboard' : 'la pieza'}{n.target ? ` (${n.target})` : ''}, {day(n.at)}{n.text ? ':' : '.'}</p>
          {n.text && <blockquote>{n.text}</blockquote>}
          <p className="client-notes-actions">
            {n.kind === 'comment' && onUse && <button onClick={() => { onUse(n.text); void mark(n, 'used') }}>Usar como indicación</button>}
            <button className="quiet" onClick={() => mark(n, n.kind === 'approve' ? 'used' : 'dismissed')}>{n.kind === 'approve' ? 'Visto' : 'Descartar'}</button>
          </p>
        </li>
      ))}</ul>
    </section>
  )
}

/** En la página del cliente: aprobar o dejar un comentario. Llega al estudio, no a los agentes. */
export function ClientVoice({ token, what, target }: { token: string; what: string; target?: string }) {
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [state, setState] = useState<'' | 'sending' | 'approve' | 'comment' | string>('')
  const send = (kind: 'approve' | 'comment') => {
    setState('sending')
    fetch(`/api/public/${token}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, name, text, target }) })
      .then(async (res) => { if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'No se pudo enviar'); setState(kind); setText('') })
      .catch((e) => setState(e.message))
  }
  const done = state === 'approve' || state === 'comment'
  return (
    <section className="client-voice" aria-label="Tu opinión">
      <h2>¿Qué te parece?</h2>
      {done ? <p className="client-voice-done" role="status">{state === 'approve' ? 'Gracias. Tu aprobación ya le llegó al equipo de Pana Films.' : 'Gracias. Tu comentario ya le llegó al equipo de Pana Films.'} <button onClick={() => setState('')}>Escribir otro</button></p> : (
        <>
          <label>Tu nombre<input type="text" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
          <label>Comentarios (opcional si apruebas)<textarea rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Qué cambiarías, qué te gusta, qué falta" /></label>
          <p className="client-voice-actions">
            <button className="primary" disabled={state === 'sending'} onClick={() => send('approve')}>Aprobar {what}</button>
            <button disabled={state === 'sending' || text.trim().length < 3} onClick={() => send('comment')}>Enviar solo comentarios</button>
          </p>
          {state && state !== 'sending' && <p className="client-voice-error" role="alert">{state}</p>}
        </>
      )}
    </section>
  )
}
