import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, openFile, setToken } from './api'
import { Office } from './office/Office'
import type { Ev, SchemeT, StageT } from './office/world'

type Project = { id: string; name: string; brief: string; scheme: string; status: string; reason: string | null; budget_cap: number; spent: number }
type Step = { stage: string; agent: string; version: number; status: string; feedback: string | null; model: string | null }
type Brand = { name: string; kit: string }
type Config = { supabaseUrl: string; supabaseAnonKey: string }
type Detail = Project & { currentStage: string | null; stages: { stage: string; status: string; attempts: number }[]; steps: Step[] }
type Settings = { humanReview: boolean; simulation: boolean }

const STATUS: Record<string, string> = { running: 'En marcha', paused: 'En pausa', waiting_human: 'Espera tu decisión', done: 'Entregado', failed: 'Detenido', cancelled: 'Cancelado' }
const usd = (n: number) => `$${n.toFixed(2)}`
const hour = (ts: string) => new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export function App() {
  const [schemes, setSchemes] = useState<SchemeT[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [pid, setPid] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [events, setEvents] = useState<Ev[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [replay, setReplay] = useState(0)
  const [replaying, setReplaying] = useState(false)
  const [error, setError] = useState('')
  const [brands, setBrands] = useState<Brand[]>([])
  const [brandName, setBrandName] = useState('')
  const [brandKit, setBrandKit] = useState('')
  const [config, setConfig] = useState<Config | null>(null)
  const [signedIn, setSignedIn] = useState(false)
  const supabase = useRef<SupabaseClient | null>(null)
  const pollNow = useRef(() => {})
  const newDialog = useRef<HTMLDialogElement>(null)
  const settingsDialog = useRef<HTMLDialogElement>(null)

  // Cuántas acciones siguen esperando respuesta del servidor: mientras haya alguna, la claqueta avisa.
  const [loading, setLoading] = useState(0)
  const act = useCallback(async (fn: () => Promise<unknown>) => {
    setLoading((n) => n + 1)
    try { setError(''); await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setLoading((n) => n - 1) }
  }, [])

  // Arranque: la sesión la lleva Supabase Auth.
  useEffect(() => {
    let off = () => {}
    void act(async () => {
      const cfg = await api<Config>('/config')
      const client = (supabase.current = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey))
      const apply = (session: { access_token: string } | null) => { setToken(session?.access_token ?? null); setSignedIn(!!session) }
      apply((await client.auth.getSession()).data.session)
      off = client.auth.onAuthStateChange((_event, session) => apply(session)).data.subscription.unsubscribe
      setConfig(cfg)
    })
    return () => off()
  }, [act])
  const ready = !!config && signedIn

  useEffect(() => {
    if (!ready) return
    void act(async () => {
      const [s, st, ps, bs] = await Promise.all([api<SchemeT[]>('/schemes'), api<Settings>('/settings'), api<Project[]>('/projects'), api<Brand[]>('/brands')])
      setSchemes(s); setSettings(st); setProjects(ps); setBrands(bs); setPid(ps[0]?.id ?? null)
    })
  }, [act, ready])

  // Eventos y estado del proyecto por consulta periódica: rápida mientras corre, lenta cuando espera.
  useEffect(() => {
    setEvents([]); setDetail(null); setSelected(null); setReplaying(false)
    if (!pid || !ready) return
    let stopped = false, busy = false, after = 0, timer = 0
    const poll = async () => {
      if (busy) return
      busy = true
      clearTimeout(timer)
      let delay = 6000
      try {
        const r = await api<{ events: Ev[]; project: Detail }>(`/projects/${pid}/events?after=${after}`)
        if (stopped) return
        if (r.events.length) { after = r.events[r.events.length - 1].id; setEvents((prev) => prev.concat(r.events)) }
        setDetail(r.project)
        if (r.project.status === 'running') delay = 1000
      } catch { /* se reintenta en la siguiente consulta */ } finally { busy = false }
      if (!stopped) timer = window.setTimeout(poll, delay)
    }
    pollNow.current = () => void poll()
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [pid, ready])

  const scheme = schemes.find((s) => s.id === detail?.scheme) ?? schemes[0]
  const endReplay = useCallback(() => setReplaying(false), [])
  const post = (path: string, body?: unknown) => act(async () => { await api(`/projects/${pid}/${path}`, 'POST', body ?? {}); pollNow.current() })

  if (config && !signedIn) return <Login onSubmit={async (email, password) => {
    const { error } = await supabase.current!.auth.signInWithPassword({ email, password })
    if (error) throw new Error('Correo o contraseña incorrectos')
  }} />
  if (!scheme || !settings) return <p className="boot">{error || 'Abriendo el estudio…'}</p>

  const stage = scheme.stages.find((s) => s.id === detail?.currentStage)
  return (
    <div className="app">
      <header className="slate">
        <div className={loading ? 'stripes busy' : 'stripes'} aria-hidden="true" />
        <div className="slate-row">
          <h1>Pana Films Lab</h1>
          <label className="field">
            <span>Producción</span>
            <select value={pid ?? ''} onChange={(e) => setPid(e.target.value)} disabled={!projects.length}>
              {!projects.length && <option value="">Sin producciones</option>}
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <ol className="stages" aria-label="Etapas">
            {scheme.stages.map((s) => {
              const row = detail?.stages.find((r) => r.stage === s.id)
              const state = row?.status === 'approved' ? 'ok' : s.id === detail?.currentStage && row ? 'now' : 'todo'
              return <li key={s.id} className={state} aria-current={state === 'now' ? 'step' : undefined}>{s.name}{state === 'now' && row!.attempts > 0 && <em> intento {row!.attempts + 1}</em>}</li>
            })}
          </ol>
          {detail && (
            <>
              <div className="field"><span>Estado</span><strong className={`status ${detail.status}`}>{STATUS[detail.status]}</strong></div>
              <div className="field budget">
                <span>Presupuesto</span>
                <strong>{usd(detail.spent)} de {usd(detail.budget_cap)}</strong>
                <progress value={Math.min(detail.spent, detail.budget_cap)} max={detail.budget_cap} />
              </div>
            </>
          )}
          <div className="actions">
            <span className="loading" role="status">{loading > 0 && 'Cargando…'}</span>
            {detail?.status === 'running' && <button onClick={() => post('pause')}>Pausar</button>}
            {detail && events.length > 0 && <button disabled={replaying} onClick={() => { setReplaying(true); setReplay((n) => n + 1) }}>{replaying ? 'Reproduciendo…' : 'Ver repetición'}</button>}
            <button onClick={() => settingsDialog.current?.showModal()}>Configuración</button>
            <button className="primary" onClick={() => newDialog.current?.showModal()}>Nuevo proyecto</button>
            <button onClick={() => supabase.current?.auth.signOut()}>Cerrar sesión</button>
          </div>
        </div>
      </header>

      {error && <p className="error" role="alert">{error} <button onClick={() => setError('')}>Cerrar</button></p>}

      <main>
        <section className="stage-floor">
          <Office key={pid ?? 'empty'} scheme={scheme} events={events} replay={replay} selected={selected} onSelect={setSelected} onReplayEnd={endReplay} />
          {!projects.length && (
            <div className="empty">
              <h2>El estudio está a oscuras</h2>
              <p>Crea la primera producción y los agentes encienden las luces, sala por sala.</p>
              <button className="primary" onClick={() => newDialog.current?.showModal()}>Nuevo proyecto</button>
            </div>
          )}
          {detail && <Decision detail={detail} stage={stage} events={events} post={post} onReplay={() => { setReplaying(true); setReplay((n) => n + 1) }} />}
        </section>
        <aside className="sheet" aria-label="Hoja de llamado">
          {detail ? <Sheet scheme={scheme} detail={detail} events={events} selected={selected} onSelect={setSelected} post={post} /> : <p className="hint">Aquí aparece el detalle de cada agente: qué está haciendo, qué entregó y cuánto ha gastado.</p>}
        </aside>
      </main>

      <dialog ref={newDialog}>
        <form method="dialog" onSubmit={(e) => {
          const f = new FormData(e.currentTarget), form = e.currentTarget
          void act(async () => {
            const p = await api<Project>('/projects', 'POST', { name: f.get('name'), brief: f.get('brief'), budgetCap: Number(f.get('budgetCap')), brandName, brandKit })
            setProjects((ps) => [p, ...ps]); setPid(p.id); form.reset(); setBrandName(''); setBrandKit('')
            setBrands(await api<Brand[]>('/brands'))
          })
        }}>
          <h2>Nuevo proyecto</h2>
          <label>Nombre de la producción<input name="name" required maxLength={80} placeholder="Café Aurora, lanzamiento" /></label>
          <label>Brief del cliente<textarea name="brief" required rows={5} placeholder="Marca, producto, público, objetivo, duración y tono." /></label>
          <label>Cliente o marca (opcional)
            <input list="brands" value={brandName} maxLength={80} placeholder="Elige uno guardado o escribe uno nuevo"
              onChange={(e) => { setBrandName(e.target.value); const known = brands.find((b) => b.name === e.target.value); if (known) setBrandKit(known.kit) }} />
            <datalist id="brands">{brands.map((b) => <option key={b.name} value={b.name} />)}</datalist>
          </label>
          {brandName.trim() && <>
            <label>Biblioteca de marca<textarea rows={4} value={brandKit} onChange={(e) => setBrandKit(e.target.value)} placeholder="Paleta con valores hex, tono de voz, frases que sí y que no, datos del producto, reglas del logo." /></label>
            <p className="note">Se guarda con el cliente y todos los agentes la reciben en sus próximos proyectos.</p>
          </>}
          <label>Tope de presupuesto en dólares<input name="budgetCap" type="number" required min="1" step="1" defaultValue={50} /></label>
          <p className="note">El motor se detiene y te pregunta cuando el gasto alcanza este tope.</p>
          <div className="dialog-actions"><button type="button" onClick={() => newDialog.current?.close()}>Cancelar</button><button className="primary">Crear proyecto</button></div>
        </form>
      </dialog>

      <dialog ref={settingsDialog}>
        <form method="dialog">
          <h2>Configuración</h2>
          <label className="check"><input type="checkbox" checked={settings.humanReview} onChange={(e) => act(async () => setSettings(await api<Settings>('/settings', 'PUT', { humanReview: e.target.checked })))} />
            <span><strong>Revisión humana en cada etapa</strong>Cuando el auditor aprueba una etapa, el proyecto espera tu visto bueno. Apagada, avanza solo. El auditor corre siempre.</span></label>
          <label className="check"><input type="checkbox" checked={settings.simulation} onChange={(e) => act(async () => setSettings(await api<Settings>('/settings', 'PUT', { simulation: e.target.checked })))} />
            <span><strong>Modo simulación</strong>Los agentes escriben entregables de muestra y no gastan. Apagado, cada agente llama a Claude y consume tu saldo de Anthropic. Las tomas de video y audio todavía no se generan.</span></label>
          <div className="dialog-actions"><button className="primary">Listo</button></div>
        </form>
      </dialog>
    </div>
  )
}

function Decision({ detail, stage, events, post: postNow, onReplay }: { detail: Detail; stage?: StageT; events: Ev[]; post: (path: string, body?: unknown) => Promise<void>; onReplay: () => void }) {
  const [rejecting, setRejecting] = useState(false)
  const [comment, setComment] = useState('')
  const [agents, setAgents] = useState<string[]>([])
  const [cap, setCap] = useState(detail.budget_cap * 2)
  useEffect(() => { setRejecting(false); setComment(''); setAgents([]) }, [detail.currentStage, detail.status])
  // El servidor tarda en confirmar; mientras tanto los botones quedan bloqueados para no enviar dos veces.
  const [sending, setSending] = useState(false)
  const post = (path: string, body?: unknown) => { setSending(true); return postNow(path, body).finally(() => setSending(false)) }
  const { status, reason } = detail

  if (status === 'waiting_human' && stage) {
    const verdict = [...events].reverse().find((e) => e.type === 'audit.verdict' && e.data.stage === stage.id)
    const escalated = reason === 'escalated'
    return (
      <div className="decision" role="region" aria-label="Decisión pendiente">
        <div>
          <h2>{escalated ? `El auditor rechazó ${stage.name} tres veces` : `${stage.name} pasó la auditoría`}</h2>
          {escalated
            ? <ul>{(verdict?.data.issues ?? []).map((i: any, n: number) => <li key={n}>{stage.agents.find((a) => a.id === i.agent)?.name}: {i.problem}</li>)}</ul>
            : <p>Te toca revisar: {stage.gate.toLowerCase()}. Haz clic en un agente para abrir sus entregables.</p>}
          {rejecting && (
            <div className="reject">
              <label>Qué hay que corregir<textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} /></label>
              <fieldset><legend>Quién lo repite (sin marcar, toda la etapa)</legend>
                {stage.agents.map((a) => <label key={a.id} className="chip"><input type="checkbox" checked={agents.includes(a.id)} onChange={(e) => setAgents((xs) => e.target.checked ? [...xs, a.id] : xs.filter((x) => x !== a.id))} />{a.name.replace(/ Agents?$/, '')}</label>)}
              </fieldset>
            </div>
          )}
        </div>
        <div className="decision-actions">
          {rejecting
            ? <><button onClick={() => setRejecting(false)}>Cancelar</button><button className="danger" disabled={sending || !comment.trim()} onClick={() => post('decision', { approve: false, comment, agents })}>Devolver etapa</button></>
            : <><button onClick={() => setRejecting(true)}>Devolver con comentario</button><button className="primary" disabled={sending} onClick={() => post('decision', { approve: true })}>{sending ? 'Aprobando…' : escalated ? 'Aprobar de todos modos' : 'Aprobar etapa'}</button></>}
        </div>
      </div>
    )
  }
  if (status === 'paused' && reason === 'budget') return (
    <div className="decision" role="region" aria-label="Presupuesto agotado">
      <div><h2>El gasto alcanzó el tope de {usd(detail.budget_cap)}</h2><label className="inline">Nuevo tope en dólares<input type="number" min={Math.ceil(detail.spent) + 1} value={cap} onChange={(e) => setCap(Number(e.target.value))} /></label></div>
      <div className="decision-actions"><button onClick={() => post('cancel')}>Cancelar proyecto</button><button className="primary" onClick={() => post('resume', { budgetCap: cap })}>Subir tope y reanudar</button></div>
    </div>
  )
  if (status === 'paused') return (
    <div className="decision"><div><h2>Proyecto en pausa</h2><p>Puedes relanzar un agente de la etapa actual con una nota desde su ficha.</p></div>
      <div className="decision-actions"><button className="primary" onClick={() => post('resume')}>Reanudar</button></div></div>
  )
  if (status === 'failed') return (
    <div className="decision"><div><h2>El motor se detuvo</h2><p>{reason}</p></div>
      <div className="decision-actions"><button className="primary" onClick={() => post('resume')}>Reintentar</button></div></div>
  )
  if (status === 'done') return (
    <div className="decision"><div><h2>Comercial entregado</h2><p>Las cinco etapas pasaron auditoría. Gasto total: {usd(detail.spent)}.</p></div>
      <div className="decision-actions"><button className="primary" onClick={onReplay}>Ver repetición</button></div></div>
  )
  return null
}

function Sheet({ scheme, detail, events, selected, onSelect, post }: { scheme: SchemeT; detail: Detail; events: Ev[]; selected: string | null; onSelect: (id: string | null) => void; post: (path: string, body?: unknown) => Promise<void> }) {
  const [note, setNote] = useState('')
  const names = useMemo(() => new Map(scheme.stages.flatMap((s) => [...s.agents, s.auditor].map((a) => [a.id, a.name] as const))), [scheme])
  // Estado actual de cada agente, derivado del historial.
  const states = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of events) {
      if (e.type === 'agent.started') m.set(e.data.agent, 'Trabajando')
      if (e.type === 'agent.done') m.set(e.data.agent, 'Entregó')
      if (e.type === 'contract.failed') m.set(e.data.agent, 'Entrega incompleta')
      if (e.type === 'audit.started') m.set(e.data.auditor, 'Auditando')
      if (e.type === 'audit.verdict') { m.set(e.data.auditor, e.data.approved ? 'Aprobó' : 'Rechazó'); for (const i of e.data.issues ?? []) m.set(i.agent, 'Devuelto') }
    }
    return m
  }, [events])

  if (!selected || selected === 'creative-lead' || selected === 'orchestrator') return (
    <>
      {selected === 'creative-lead' && <p className="hint">Eres tú. Las decisiones que te esperan aparecen debajo de la oficina.</p>}
      {selected === 'orchestrator' && <p className="hint">El Orchestrator es el motor: lanza a cada agente, llama al auditor, controla el gasto y te avisa cuando te necesita.</p>}
      <h2>Reparto</h2>
      {scheme.stages.map((s) => (
        <section key={s.id} className="cast">
          <h3>{s.name}</h3>
          <ul>{[...s.agents, s.auditor].map((a) => (
            <li key={a.id}><button onClick={() => onSelect(a.id)}><span>{a.name}</span><small data-state={states.get(a.id) ?? ''}>{states.get(a.id) ?? 'En espera'}</small></button></li>
          ))}</ul>
        </section>
      ))}
    </>
  )

  const stage = scheme.stages.find((s) => s.auditor.id === selected || s.agents.some((a) => a.id === selected))!
  const agent = stage.agents.find((a) => a.id === selected)
  const steps = detail.steps.filter((s) => s.agent === selected)
  const log: { ts: string; text: string; bad?: boolean }[] = []
  let cost = 0
  for (const e of events) {
    const d = e.data, mine = d.agent === selected || d.auditor === selected
    if (e.type === 'agent.started' && mine) log.push({ ts: e.ts, text: d.feedback ? `Empezó la versión ${d.version} para corregir: ${d.feedback}` : `Empezó la versión ${d.version}` })
    else if (e.type === 'agent.message' && mine) log.push({ ts: e.ts, text: d.text })
    else if (e.type === 'agent.done' && mine) log.push({ ts: e.ts, text: `Entregó a ${names.get(d.to) ?? d.to}` })
    else if (e.type === 'contract.failed' && mine) log.push({ ts: e.ts, text: `Entrega incompleta: ${d.problem}`, bad: true })
    else if (e.type === 'audit.started' && mine) log.push({ ts: e.ts, text: 'Empezó la auditoría' })
    else if (e.type === 'audit.verdict' && mine) log.push({ ts: e.ts, text: d.approved ? 'Aprobó la etapa' : `Rechazó: ${d.issues.map((i: any) => `${names.get(i.agent)} (${i.problem})`).join('; ')}`, bad: !d.approved })
    else if (e.type === 'audit.verdict') for (const i of d.issues ?? []) if (i.agent === selected) log.push({ ts: e.ts, text: `El auditor devolvió la entrega: ${i.problem}`, bad: true })
    if (e.type === 'cost' && mine) cost += d.usd
  }
  const canRerun = agent && detail.status === 'paused' && detail.currentStage === stage.id
  const canRestore = agent && (detail.status === 'paused' || detail.status === 'waiting_human') && detail.currentStage === stage.id

  return (
    <>
      <button className="back" onClick={() => onSelect(null)}>Volver al reparto</button>
      <h2>{names.get(selected)}</h2>
      <p className="meta">{stage.name}. {states.get(selected) ?? 'En espera'}. Gasto {usd(cost)}.</p>
      {agent && (
        <section>
          <h3>Entregables</h3>
          {!steps.length && <p className="hint">Todavía no ha entregado nada.</p>}
          {[...steps].reverse().map((s) => (
            <div key={s.version} className="version">
              <strong>Versión {s.version}{s.status === 'rejected' && ' (devuelta)'}</strong>
              {s.model && <p className="origin">{s.model.startsWith('copia') ? `Es una ${s.model}` : `Hecha con ${s.model}`}</p>}
              {s.feedback && <p className="bad">{s.feedback}</p>}
              <ul>{[...agent.deliverables, 'handoff.json'].map((f) => <li key={f}><button className="file" onClick={() => openFile(`/projects/${detail.id}/files/${stage.id}/${agent.id}/v${s.version}/${f}`).catch(() => {})}>{f}</button></li>)}</ul>
              {canRestore && s.version < steps[steps.length - 1].version && <button onClick={() => post('restore', { agent: selected, version: s.version })}>Volver a esta versión</button>}
            </div>
          ))}
        </section>
      )}
      {canRerun && (
        <section>
          <h3>Relanzar con una nota</h3>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Qué debe cambiar en la próxima versión" />
          <button className="primary" disabled={!note.trim()} onClick={() => post('rerun', { agent: selected, note }).then(() => setNote(''))}>Relanzar agente</button>
        </section>
      )}
      <section>
        <h3>Registro</h3>
        {!log.length && <p className="hint">Sin actividad todavía.</p>}
        <ol className="log">{[...log].reverse().map((l, i) => <li key={i} className={l.bad ? 'bad' : ''}><time>{hour(l.ts)}</time>{l.text}</li>)}</ol>
      </section>
    </>
  )
}

function Login({ onSubmit }: { onSubmit: (email: string, password: string) => Promise<void> }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="login">
      <div className="stripes" aria-hidden="true" />
      <form onSubmit={(e) => {
        e.preventDefault()
        const f = new FormData(e.currentTarget)
        setBusy(true); setError('')
        onSubmit(String(f.get('email')), String(f.get('password'))).catch((err) => setError(err.message)).finally(() => setBusy(false))
      }}>
        <h1>Pana Films Lab</h1>
        <p>Entra con tu cuenta del estudio.</p>
        <label>Correo<input name="email" type="email" required autoComplete="username" /></label>
        <label>Contraseña<input name="password" type="password" required autoComplete="current-password" /></label>
        {error && <p className="bad" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </div>
  )
}
