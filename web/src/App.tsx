import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Admin } from './Admin'
import { Config, type Settings } from './Config'
import { Explore } from './Explore'
import { ClientNotes, Improve } from './Extras'
import { api, openFile, setOnExpired, setToken, upload } from './api'
import { Media, mediaKind } from './media'
import { Team } from './Team'
import { Profit } from './Profit'
import { Office } from './office/Office'
import type { Ev, SchemeT, StageT } from './office/world'

type Project = { id: string; name: string; brand: string | null; brief: string; scheme: string; status: string; reason: string | null; budget_cap: number; spent: number; simulation: boolean }
type Step = { stage: string; agent: string; version: number; status: string; feedback: string | null; model: string | null }
type Brand = { name: string; kit: string }
type Config = { supabaseUrl: string; supabaseAnonKey: string }
type Detail = Project & { currentStage: string | null; stages: { stage: string; status: string; attempts: number }[]; steps: Step[] }
type Asset = { path: string; tool: string; model: string; costUsd: number; license: string; measurements: { durationSeconds: number | null; width: number | null; height: number | null; lufs: number | null } | null }

/** La pieza final más reciente, si Motion Graphics ya la entregó. */
function masterPath(events: Ev[]): string | null {
  const done = [...events].reverse().find((e) => e.type === 'agent.done' && e.data.agent === 'motion-graphics' && e.data.files?.includes('master.mp4'))
  return done ? `${done.data.stage}/motion-graphics/v${done.data.version}/master.mp4` : null
}

type View = 'studio' | 'producciones' | 'rentabilidad' | 'equipo' | 'configuracion'
const viewOf = (hash: string): View => (hash === '#/producciones' ? 'producciones' : hash === '#/rentabilidad' ? 'rentabilidad' : hash === '#/equipo' ? 'equipo' : hash === '#/configuracion' ? 'configuracion' : 'studio')

const STATUS: Record<string, string> = { exploring: 'Explorando el look', running: 'En marcha', paused: 'En pausa', waiting_human: 'Espera tu decisión', done: 'Entregado', failed: 'Detenido', cancelled: 'Cancelado' }
const usd = (n: number) => `$${n.toFixed(2)}`
const hour = (ts: string) => new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export function App() {
  const [schemes, setSchemes] = useState<SchemeT[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [pid, setPid] = useState<string | null>(null)
  const [loadedDetail, setDetail] = useState<Detail | null>(null)
  const [loadedEvents, setEvents] = useState<Ev[]>([])
  // Al cambiar de producción, lo cargado de la anterior sigue en memoria un instante: no se muestra ni se anima.
  const detail = loadedDetail?.id === pid ? loadedDetail : null
  const events = useMemo(() => (loadedEvents[0]?.projectId === pid ? loadedEvents : []), [loadedEvents, pid])
  const [selected, setSelected] = useState<string | null>(null)
  const [replay, setReplay] = useState(0)
  // Sube con cada "Nuevo proyecto": la oficina libre se cuadra ante la noticia.
  const [rally, setRally] = useState(0)
  // Con la oficina en modo libre y a la vista, el formulario espera a que el equipo conteste y corra a sus puestos: detrás de un diálogo no se vería.
  const callToSet = () => { setRally((n) => n + 1); const show = () => newDialog.current?.showModal(); if (!pid && viewOf(location.hash) === 'studio' && !matchMedia('(prefers-reduced-motion: reduce)').matches) window.setTimeout(show, 2300); else show() }
  const [replaying, setReplaying] = useState(false)
  const [error, setError] = useState('')
  const [brands, setBrands] = useState<Brand[]>([])
  const [brandName, setBrandName] = useState('')
  const [brandKit, setBrandKit] = useState('')
  const [config, setConfig] = useState<Config | null>(null)
  const [me, setMe] = useState<{ email: string; role: 'admin' | 'member' } | null>(null)
  // La pantalla actual va en la dirección, para que recargar o compartirla lleve al mismo sitio.
  const [view, setView] = useState<View>(viewOf(location.hash))
  useEffect(() => {
    const onHash = () => setView(viewOf(location.hash))
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, [])
  const go = (v: View) => { location.hash = v === 'studio' ? '' : `#/${v}` }
  const [signedIn, setSignedIn] = useState(false)
  const supabase = useRef<SupabaseClient | null>(null)
  const pollNow = useRef(() => {})
  const newDialog = useRef<HTMLDialogElement>(null)
  const budgetDialog = useRef<HTMLDialogElement>(null)

  // Cuántas acciones siguen esperando respuesta del servidor: mientras haya alguna, la claqueta avisa.
  const [loading, setLoading] = useState(0)
  /** Ejecuta una acción mostrando la carga y el error. Devuelve si salió bien. */
  const act = useCallback(async (fn: () => Promise<unknown>) => {
    setLoading((n) => n + 1)
    try { setError(''); await fn(); return true } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false } finally { setLoading((n) => n - 1) }
  }, [])

  // Arranque: la sesión la lleva Supabase Auth.
  useEffect(() => {
    let off = () => {}, gone = false
    void act(async () => {
      const cfg = await api<Config>('/config')
      if (gone) return
      const client = (supabase.current = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey))
      const apply = (session: { access_token: string } | null) => { setToken(session?.access_token ?? null); setSignedIn(!!session) }
      setOnExpired(() => void client.auth.signOut())
      apply((await client.auth.getSession()).data.session)
      const sub = client.auth.onAuthStateChange((_event, session) => apply(session)).data.subscription
      off = () => sub.unsubscribe()
      if (gone) off()
      setConfig(cfg)
    })
    return () => { gone = true; off() }
  }, [act])
  const ready = !!config && signedIn

  useEffect(() => {
    if (!ready) return
    void act(async () => {
      const [s, st, ps, bs, who] = await Promise.all([api<SchemeT[]>('/schemes'), api<Settings>('/settings'), api<Project[]>('/projects'), api<Brand[]>('/brands'), api<{ email: string; role: 'admin' | 'member' }>('/me')])
      setSchemes(s); setSettings(st); setProjects(ps); setBrands(bs); setMe(who); setPid((current) => (ps.some((p) => p.id === current) ? current : null))
    })
  }, [act, ready])

  // Eventos y estado del proyecto por consulta periódica: rápida mientras corre, lenta cuando espera.
  useEffect(() => {
    setEvents([]); setDetail(null); setSelected(null); setReplaying(false)
    if (!pid || !ready) return
    let stopped = false, busy = false, again = false, after = 0, timer = 0
    const poll = async () => {
      // Si piden refrescar a mitad de una consulta, se repite al terminar: esa consulta puede traer el estado viejo.
      if (busy) { again = true; return }
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
      if (again) delay = 0
      again = false
      if (!stopped) timer = window.setTimeout(poll, delay)
    }
    pollNow.current = () => void poll()
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [pid, ready])

  const scheme = schemes.find((s) => s.id === detail?.scheme) ?? schemes[0]
  const endReplay = useCallback(() => setReplaying(false), [])
  // Un comentario del cliente que se quiere convertir en mejora: llega escrito al formulario.
  const [wish, setWish] = useState('')
  // Se vacía al cambiar de producción y cuando la indicación ya se envió (el estado cambia).
  useEffect(() => setWish(''), [pid, detail?.status])
  // Cierre de rodaje: solo cuando la producción termina mientras la estás mirando, no al abrir una ya entregada.
  const [wrapped, setWrapped] = useState<string | null>(null)
  const last = useRef<{ id: string; status: string } | null>(null)
  useEffect(() => {
    if (!detail) return
    if (last.current?.id === detail.id && last.current.status !== 'done' && detail.status === 'done') setWrapped(detail.name)
    last.current = { id: detail.id, status: detail.status }
  }, [detail?.id, detail?.status])
  const post = (path: string, body?: unknown) => act(async () => { try { await api(`/projects/${pid}/${path}`, 'POST', body ?? {}) } finally { pollNow.current() } })

  if (config && !signedIn) return <Login onSubmit={async (email, password) => {
    const { error } = await supabase.current!.auth.signInWithPassword({ email, password })
    if (error) throw new Error('Correo o contraseña incorrectos')
  }} />
  if (!scheme || !settings) return <p className="boot">{error || 'Abriendo el estudio…'}</p>

  const stage = scheme.stages.find((s) => s.id === detail?.currentStage)
  // Las pantallas de administración solo existen para administradores; a los demás la dirección los devuelve al estudio.
  // Quien no administra solo tiene el estudio y sus propios avisos.
  const screen: View = me?.role === 'admin' || view === 'configuracion' ? view : 'studio'
  return (
    <div className="app">
      <header className="slate">
        <div className={loading ? 'stripes busy' : 'stripes'} aria-hidden="true" />
        <div className="slate-row">
          <h1>Pana Films Lab</h1>
          {me?.role === 'admin' && (
            <nav className="views" aria-label="Secciones">
              <button aria-current={screen === 'studio' ? 'page' : undefined} onClick={() => go('studio')}>Estudio</button>
              <button aria-current={screen === 'producciones' ? 'page' : undefined} onClick={() => go('producciones')}>Producciones</button>
              <button aria-current={screen === 'rentabilidad' ? 'page' : undefined} onClick={() => go('rentabilidad')}>Rentabilidad</button>
              <button aria-current={screen === 'equipo' ? 'page' : undefined} onClick={() => go('equipo')}>Equipo</button>
              <button aria-current={screen === 'configuracion' ? 'page' : undefined} onClick={() => go('configuracion')}>Configuración</button>
            </nav>
          )}
          {me?.role === 'member' && (
            <nav className="views" aria-label="Secciones">
              <button aria-current={screen === 'studio' ? 'page' : undefined} onClick={() => go('studio')}>Estudio</button>
              <button aria-current={screen === 'configuracion' ? 'page' : undefined} onClick={() => go('configuracion')}>Mis avisos</button>
            </nav>
          )}
          <div className="actions">
            <span className="loading" role="status">{loading > 0 && 'Cargando…'}</span>
            {screen === 'studio' && detail?.status === 'running' && <button onClick={() => post('pause')}>Pausar</button>}
            {screen === 'studio' && detail && events.length > 0 && <button disabled={replaying} onClick={() => { setReplaying(true); setReplay((n) => n + 1) }}>{replaying ? 'Reproduciendo…' : 'Ver repetición'}</button>}
            <button className="primary" onClick={callToSet}>Nuevo proyecto</button>
            <button onClick={() => supabase.current?.auth.signOut()}>Cerrar sesión</button>
          </div>
        </div>
        {screen === 'studio' && (
        <div className="slate-row second">
          <label className="field">
            <span>Producción</span>
            <select value={pid ?? ''} onChange={(e) => setPid(e.target.value || null)} disabled={!projects.length}>
              <option value="">{projects.length ? 'Elige una producción' : 'Sin producciones'}</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.simulation ? ' (simulación)' : ''}</option>)}
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
            <div className="readout">
              <div className="field"><span>Estado</span><strong className={`status ${detail.status}`}>{STATUS[detail.status]}</strong></div>
              <div className="field"><span>Modo</span><strong>{detail.simulation ? 'Simulación, no gasta' : 'Real'}</strong></div>
              <div className={detail.spent >= detail.budget_cap * 0.85 ? 'field budget near' : 'field budget'}>
                <span>Presupuesto</span>
                <strong>{usd(detail.spent)} de {usd(detail.budget_cap)}</strong>
                {!['done', 'cancelled'].includes(detail.status) && <button className="raise" aria-label="Subir el tope de presupuesto" title="Subir el tope de presupuesto" onClick={() => budgetDialog.current?.showModal()}>+ Tope</button>}
                <progress value={Math.min(detail.spent, detail.budget_cap)} max={detail.budget_cap} />
              </div>
            </div>
          )}
        </div>
        )}
      </header>

      {wrapped && (
        <div className="wrap" role="status" onClick={() => setWrapped(null)}>
          <div className="confetti" aria-hidden="true">{Array.from({ length: 24 }, (_, n) => <i key={n} style={{ '--n': n } as CSSProperties} />)}</div>
          <div className="wrap-card">
            <p className="wrap-kicker">Fin de rodaje</p>
            <h2>¡Corten!</h2>
            <p>«{wrapped}» pasó las cinco etapas y está entregado. La pieza y su hoja de costos te esperan en Producciones.</p>
            <button className="primary" autoFocus onClick={() => setWrapped(null)}>Ver el estudio</button>
          </div>
        </div>
      )}
      {error && <p className="error" role="alert">{error} <button onClick={() => setError('')}>Cerrar</button></p>}

      {screen === 'producciones' && <Admin act={act} onOpen={(id) => { setPid(id); go('studio') }} />}
      {screen === 'rentabilidad' && <Profit act={act} />}
      {screen === 'equipo' && me && <Team me={me.email} act={act} />}
      {screen === 'configuracion' && settings && <Config settings={settings} schemes={schemes} admin={me?.role === 'admin'} act={act} onChange={setSettings} />}
      {screen === 'studio' && detail?.status === 'exploring' && <Explore project={detail} admin={me?.role === 'admin'} act={act} onChanged={() => pollNow.current()} onRaise={() => budgetDialog.current?.showModal()} />}
      <main hidden={screen !== 'studio' || detail?.status === 'exploring'}>
        <section className="stage-floor">
          {detail && <p className={`on-air ${detail.status}`} role="status">{detail.status === 'running' ? 'En el aire' : detail.status === 'done' ? 'Entregado' : detail.status === 'waiting_human' ? 'Te esperan en el plató' : 'Fuera del aire'}</p>}
          <Office key={pid ?? 'empty'} scheme={scheme} events={events} replay={replay} selected={selected} onSelect={setSelected} onReplayEnd={endReplay} free={!pid} rally={rally} />
          {!projects.length && (
            <div className="empty">
              <h2>El estudio está a oscuras</h2>
              <p>Crea la primera producción y los agentes encienden las luces, sala por sala.</p>
              <button className="primary" onClick={callToSet}>Nuevo proyecto</button>
            </div>
          )}
          {detail && <ClientNotes pid={detail.id} act={act} refresh={events.filter((e) => e.type === 'client.feedback').length} onUse={['done', 'waiting_human'].includes(detail.status) ? setWish : undefined} />}
          {detail && <Decision wish={wish} detail={detail} scheme={scheme} stage={stage} events={events} post={post} onSelect={setSelected} onReplay={() => { setReplaying(true); setReplay((n) => n + 1) }} />}
        </section>
        <aside className="sheet" aria-label="Hoja de llamado">
          {detail ? <Sheet scheme={scheme} detail={detail} events={events} selected={selected} onSelect={setSelected} post={post} /> : <p className="hint">Aquí aparece el detalle de cada agente: qué está haciendo, qué entregó y cuánto ha gastado.</p>}
        </aside>
      </main>

      <dialog ref={newDialog}>
        <form method="dialog" onSubmit={(e) => {
          const f = new FormData(e.currentTarget), form = e.currentTarget
          void act(async () => {
            // Va como formulario porque lleva las fotos de referencia: se guardan antes de que arranque el primer agente.
            f.set('brandName', brandName); f.set('brandKit', brandKit)
            const p = await upload<Project>('/projects', f)
            setProjects((ps) => [p, ...ps]); setPid(p.id); form.reset(); setBrandName(''); setBrandKit('')
            setBrands(await api<Brand[]>('/brands'))
          })
        }}>
          <h2>Nuevo proyecto</h2>
          {projects.length > 0 && (
            <label>Partir de una producción anterior (opcional)
              <select name="templateId" defaultValue="" onChange={(e) => {
                const from = projects.find((p) => p.id === e.target.value), form = e.currentTarget.form
                if (!from || !form) return
                // Trae su brief, su cliente y su tope para editarlos; sus imágenes de referencia se copian al crear.
                ;(form.elements.namedItem('brief') as HTMLTextAreaElement).value = from.brief
                ;(form.elements.namedItem('budgetCap') as HTMLInputElement).value = String(from.budget_cap)
                setBrandName(from.brand ?? ''); setBrandKit(brands.find((b) => b.name === from.brand)?.kit ?? '')
              }}>
                <option value="">Empezar de cero</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          )}
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
            <BrandFiles brand={brandName.trim()} act={act} />
          </>}
          <fieldset className="brand-files">
            <legend>Imágenes de referencia</legend>
            <label>Fotos (PNG o JPG, hasta 10 de 5 MB)<input name="references" type="file" multiple accept="image/png,image/jpeg" /></label>
            <label>Qué deben tomar los agentes de estas fotos<input name="referenceNote" type="text" maxLength={500} placeholder="Por ejemplo: el estilo de luz, el tipo de cocina y la edad de la protagonista" /></label>
            <p className="note">Todos los agentes las reciben desde Strategy, junto con esta indicación. Cuanto más concreta sea, menos rechazos y repeticiones. Podrás añadir más en cada aprobación.</p>
          </fieldset>
          <label>Tope de presupuesto en dólares<input name="budgetCap" type="number" required min="1" step="1" key={settings?.defaultBudget} defaultValue={settings?.defaultBudget ?? 50} /></label>
          <p className="note">El motor se detiene y te pregunta cuando el gasto alcanza este tope.</p>
          <label className="check"><input name="explore" type="checkbox" defaultChecked />
            <span><strong>Explorar el look antes de producir</strong>El proyecto abre en la sala de exploración: generas opciones de protagonista, locación y look, eliges las referencias y puedes enseñarle el moodboard al cliente. Nada más corre ni gasta hasta que pulses «Iniciar producción». Sin marcar, arranca directo.</span></label>
          <div className="dialog-actions"><button type="button" onClick={() => newDialog.current?.close()}>Cancelar</button><button className="primary">Crear proyecto</button></div>
        </form>
      </dialog>

      <dialog ref={budgetDialog}>
        {detail && (
          <form method="dialog" key={detail.budget_cap} onSubmit={(e) => { void post('budget', { budgetCap: Number(new FormData(e.currentTarget).get('budgetCap')) }) }}>
            <h2>Subir el tope de presupuesto</h2>
            <p>Van {usd(detail.spent)} gastados de {usd(detail.budget_cap)}. El cambio vale de inmediato: los agentes siguen trabajando sin pausa.</p>
            <label>Tope nuevo en dólares<input name="budgetCap" type="number" required min={Math.floor(detail.spent) + 1} max={10000} step="1" defaultValue={Math.ceil(detail.budget_cap * 1.5)} /></label>
            <div className="dialog-actions"><button type="button" onClick={() => budgetDialog.current?.close()}>Cancelar</button><button className="primary">Guardar tope</button></div>
          </form>
        )}
      </dialog>
    </div>
  )
}

/** Logo y fotos de producto reales del cliente. Se suben al elegirlos y quedan guardados con la marca. */
function BrandFiles({ brand, act }: { brand: string; act: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const [files, setFiles] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  // Cuenta las subidas: confirma la última y obliga a recargar la miniatura cuando un logo reemplaza a otro.
  const [done, setDone] = useState(0)
  const path = `/brands/${encodeURIComponent(brand)}/assets`
  const current = useRef(path)
  current.current = path
  useEffect(() => {
    let gone = false
    setFiles([]); setDone(0)
    // Espera a que termines de escribir el nombre antes de consultar.
    const timer = window.setTimeout(() => api<string[]>(path).then((f) => { if (!gone) setFiles(f) }).catch(() => {}), 400)
    return () => { gone = true; clearTimeout(timer) }
  }, [path])
  const send = (kind: 'logo' | 'product', input: HTMLInputElement) => {
    const chosen = [...(input.files ?? [])]
    if (!chosen.length) return
    setSending(true)
    void act(async () => {
      for (const file of chosen) {
        const form = new FormData()
        form.set('file', file); form.set('kind', kind)
        const saved = await upload<string[]>(path, form)
        // Si el nombre de la marca cambió mientras subía, esta lista ya no es la que se muestra.
        if (current.current === path) { setFiles(saved); setDone((n) => n + 1) }
      }
    }).finally(() => { setSending(false); input.value = '' })
  }
  return (
    <fieldset className="brand-files" disabled={sending}>
      <legend>Archivos reales de «{brand}»</legend>
      <label>Logos<input type="file" multiple accept="image/png,image/jpeg,image/svg+xml" onChange={(e) => send('logo', e.currentTarget)} /></label>
      <label>Fotos del producto<input type="file" multiple accept="image/png,image/jpeg" onChange={(e) => send('product', e.currentTarget)} /></label>
      <p className="saved" role="status">{sending ? 'Subiendo…' : done ? 'Archivo guardado.' : files.length ? `${files.length} archivo${files.length > 1 ? 's' : ''} guardado${files.length > 1 ? 's' : ''} de este cliente.` : 'Sin archivos todavía.'}</p>
      {files.length > 0 && <ul className="thumbs">{files.map((f) => (
        <li key={f}>{mediaKind(f) === 'image' && <Media key={done} path={`/brands/${encodeURIComponent(brand)}/files/${f}`} name={f} />}<span>{f}</span></li>
      ))}</ul>}
      <p className="note">Escribe el nombre completo de la marca antes de subir: se guardan con ese nombre. El logo y el producto nunca se generan con IA: el cierre usa este logo y las tomas usan estas fotos como referencia.</p>
    </fieldset>
  )
}

type Ref = { file: string; note: string; stage: string }

/** Fotos de referencia que se adjuntan al revisar una etapa. Los agentes las reciben junto con la indicación. */
function References({ pid, onAdded }: { pid: string; onAdded: (file: string) => void }) {
  const [refs, setRefs] = useState<Ref[]>([])
  const [note, setNote] = useState('')
  const [state, setState] = useState('')
  const path = `/projects/${pid}/references`
  useEffect(() => { setRefs([]); setState(''); api<Ref[]>(path).then(setRefs).catch(() => {}) }, [path])
  const send = async (input: HTMLInputElement) => {
    const chosen = [...(input.files ?? [])]
    if (!chosen.length) return
    setState('Subiendo…')
    try {
      for (const file of chosen) {
        const form = new FormData()
        form.set('file', file); form.set('note', note)
        const saved = await upload<Ref[]>(path, form)
        setRefs(saved); onAdded(saved[saved.length - 1].file)
      }
      setState('Referencia guardada: los agentes la recibirán.'); setNote('')
    } catch (err) {
      setState(err instanceof Error ? err.message : 'No se pudo subir el archivo')
    } finally { input.value = '' }
  }
  return (
    <fieldset className="brand-files refs" disabled={state === 'Subiendo…'}>
      <legend>Fotos de referencia para los agentes</legend>
      <label>Qué deben tomar de la foto<input type="text" maxLength={500} placeholder="Por ejemplo: así debe verse la cocina del plano 2" value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <label>Fotos (PNG o JPG, hasta 5 MB)<input type="file" multiple accept="image/png,image/jpeg" onChange={(e) => void send(e.currentTarget)} /></label>
      <p className="saved" role="status">{state || (refs.length ? `${refs.length} referencia${refs.length > 1 ? 's' : ''} en este proyecto.` : 'Escribe primero la indicación y luego elige la foto.')}</p>
      {refs.length > 0 && <ul className="thumbs">{refs.map((r) => (
        <li key={r.file}><Media path={`/projects/${pid}/files/${r.file}`} name={r.file} /><span>{r.note || r.file.split('/').pop()}</span></li>
      ))}</ul>}
    </fieldset>
  )
}

function Decision({ wish, detail, scheme, stage, events, post: postNow, onSelect, onReplay }: { wish: string; detail: Detail; scheme: SchemeT; stage?: StageT; events: Ev[]; post: (path: string, body?: unknown) => Promise<boolean>; onSelect: (id: string) => void; onReplay: () => void }) {
  const [rejecting, setRejecting] = useState(false)
  const [comment, setComment] = useState('')
  // Un comentario del cliente que se quiere usar al devolver la etapa llega ya escrito.
  useEffect(() => { if (wish && detail.status === 'waiting_human') { setComment(wish); setRejecting(true) } }, [wish])
  const [agents, setAgents] = useState<string[]>([])
  // Las referencias subidas en esta revisión: si se devuelve la etapa, se nombran en la indicación.
  const [added, setAdded] = useState<string[]>([])
  const [cap, setCap] = useState(detail.budget_cap * 2)
  // Cada decisión tomada cierra el panel: dos aprobaciones seguidas de la misma etapa no comparten comentario ni marcas.
  const decisions = useMemo(() => events.filter((e) => e.type === 'gate.decided').length, [events])
  useEffect(() => { setRejecting(false); setComment(''); setAgents([]); setAdded([]); setCap(detail.budget_cap * 2) }, [detail.currentStage, detail.status, detail.budget_cap, decisions])
  // El servidor tarda en confirmar; mientras tanto los botones quedan bloqueados para no enviar dos veces.
  const [sending, setSending] = useState(false)
  const post = (path: string, body?: unknown) => { setSending(true); return postNow(path, body).finally(() => setSending(false)) }
  const { status, reason } = detail
  const master = useMemo(() => masterPath(events), [events])
  // En la aprobación de Pre-production se ve el animatic del storyboard, no la pieza final.
  const animatic = useMemo(() => { const e = [...events].reverse().find((e) => e.type === 'agent.done' && e.data.agent === 'storyboard-previs' && e.data.files?.includes('animatic.mp4')); return e ? `${e.data.stage}/storyboard-previs/v${e.data.version}/animatic.mp4` : null }, [events])
  // Agentes de etapas anteriores marcados para repetir: devolverles trabajo reabre esas etapas y cuesta más.
  const earlier = stage ? agents.filter((a) => !stage.agents.some((x) => x.id === a)).length : 0
  // La pieza final se ve aquí mismo desde que existe: en la aprobación del corte, en la entrega y al terminar.
  const piece = master && <div className="decision-media"><Media path={`/projects/${detail.id}/files/${master}`} name="master.mp4" /></div>

  if (status === 'waiting_human' && stage) {
    const verdict = [...events].reverse().find((e) => e.type === 'audit.verdict' && e.data.stage === stage.id)
    const escalated = reason === 'escalated'
    return (
      <div className="decision" role="region" aria-label="Decisión pendiente">
        {(stage.id === 'postproduction' || stage.id === 'delivery') && piece}
        {stage.id === 'preproduction' && animatic && <div className="decision-media"><Media path={`/projects/${detail.id}/files/${animatic}`} name="animatic.mp4" /></div>}
        <div>
          <h2>{escalated ? `El auditor rechazó ${stage.name} tres veces` : `${stage.name} pasó la auditoría`}</h2>
          {escalated
            ? <ul>{(verdict?.data.issues ?? []).map((i: any, n: number) => <li key={n}>{stage.agents.find((a) => a.id === i.agent)?.name}: {i.problem}</li>)}</ul>
            : <p>Te toca revisar: {stage.gate.toLowerCase()}. Abre lo que entregó cada agente; es lo mismo que revisó el auditor.</p>}
          <p className="review">
            {stage.agents.map((a) => <button key={a.id} onClick={() => onSelect(a.id)}>{a.name.replace(/ Agents?$/, '')}</button>)}
            <button onClick={() => onSelect(stage.auditor.id)}>Qué dijo el auditor</button>
          </p>
          <References pid={detail.id} onAdded={(f) => setAdded((xs) => [...xs, f])} />
          {rejecting && (
            <div className="reject">
              <label>Qué hay que corregir<textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} /></label>
              <fieldset><legend>Quién lo repite (sin marcar, toda la etapa)</legend>
                {stage.agents.map((a) => <label key={a.id} className="chip"><input type="checkbox" checked={agents.includes(a.id)} onChange={(e) => setAgents((xs) => e.target.checked ? [...xs, a.id] : xs.filter((x) => x !== a.id))} />{a.name.replace(/ Agents?$/, '')}</label>)}
              </fieldset>
              {scheme.stages.indexOf(stage) > 0 && (
                <details open={earlier > 0 || undefined}>
                  <summary>El problema viene de una etapa anterior{earlier > 0 && ` (${earlier} marcado${earlier > 1 ? 's' : ''})`}</summary>
                  <p className="note">Marca al agente que debe rehacer su trabajo, por ejemplo quien generó una toma defectuosa. Todo lo que se hizo después se actualiza a partir de lo ya entregado, y las etapas reabiertas vuelven a pasar por su auditor y por tu aprobación. Cuesta más que una devolución dentro de la etapa.</p>
                  {scheme.stages.slice(0, scheme.stages.indexOf(stage)).map((s) => (
                    <fieldset key={s.id}><legend>{s.name}</legend>
                      {s.agents.map((a) => <label key={a.id} className="chip"><input type="checkbox" checked={agents.includes(a.id)} onChange={(e) => setAgents((xs) => e.target.checked ? [...xs, a.id] : xs.filter((x) => x !== a.id))} />{a.name.replace(/ Agents?$/, '')}</label>)}
                    </fieldset>
                  ))}
                </details>
              )}
            </div>
          )}
        </div>
        <div className="decision-actions">
          {rejecting
            ? <><button onClick={() => setRejecting(false)}>Cancelar</button><button className="danger" disabled={sending || !comment.trim()} onClick={() => post('decision', { approve: false, comment, agents, references: added })}>Devolver etapa</button></>
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
    <div className="decision">{piece}<div><h2>Comercial entregado</h2><p>Las cinco etapas pasaron auditoría. Gasto total: {usd(detail.spent)}.</p></div>
      <div className="decision-actions"><button className="primary" onClick={onReplay}>Ver repetición</button></div>
      <Improve scheme={scheme} spent={detail.spent} draft={wish} post={post} /></div>
  )
  return null
}

function Sheet({ scheme, detail, events, selected, onSelect, post }: { scheme: SchemeT; detail: Detail; events: Ev[]; selected: string | null; onSelect: (id: string | null) => void; post: (path: string, body?: unknown) => Promise<boolean> }) {
  const [note, setNote] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [assets, setAssets] = useState<Asset[]>([])
  const delivered = detail.steps.filter((s) => s.agent === selected).length
  // La procedencia se consulta al abrir la ficha de un agente y cada vez que entrega una versión.
  useEffect(() => {
    setOpen(null)
    if (!selected) return
    let gone = false
    api<Asset[]>(`/projects/${detail.id}/assets`).then((a) => { if (!gone) setAssets(a) }).catch(() => {})
    return () => { gone = true }
  }, [detail.id, selected, delivered])
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

  if (!selected || selected === 'creative-lead' || selected === 'creative-manager' || selected === 'orchestrator') return (
    <>
      {selected === 'creative-lead' && <p className="hint">Eres tú. Las decisiones que te esperan aparecen debajo de la oficina.</p>}
      {selected === 'creative-manager' && <p className="hint">El Creative Manager acompaña al Creative Lead en el Mando. Toca la raqueta dorada para verlos jugar.</p>}
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
  // Archivos reales de cada versión: los entregables fijos más lo que el agente generó.
  const produced = new Map<number, string[]>()
  for (const e of events) if (e.type === 'agent.done' && e.data.agent === selected && Array.isArray(e.data.files)) produced.set(e.data.version, e.data.files)
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
              <ul>{[...new Set([...(produced.get(s.version) ?? agent.deliverables), 'handoff.json'])].map((f) => {
                const rel = `${stage.id}/${agent.id}/v${s.version}/${f}`, url = `/projects/${detail.id}/files/${rel}`
                const origin = assets.find((a) => a.path === rel), m = origin?.measurements
                if (!mediaKind(f)) return <li key={f}><button className="file" onClick={() => openFile(url).catch(() => {})}>{f}</button></li>
                return (
                  <li key={f}>
                    <button className="file" aria-expanded={open === rel} onClick={() => setOpen(open === rel ? null : rel)}>{f}</button>
                    {origin && <span className="origin"> {[m?.width && `${m.width}x${m.height}`, m?.durationSeconds && `${m.durationSeconds} s`, m?.lufs != null && `${m.lufs} LUFS`, origin.costUsd > 0 && usd(origin.costUsd)].filter(Boolean).join(', ')}</span>}
                    {open === rel && <><Media path={url} name={f} />{origin && <p className="origin">Hecho con {origin.tool}, {origin.model}. {origin.license}</p>}</>}
                  </li>
                )
              })}</ul>
              {canRestore && s.version < steps[steps.length - 1].version && <button onClick={() => post('restore', { agent: selected, version: s.version })}>Volver a esta versión</button>}
            </div>
          ))}
        </section>
      )}
      {canRerun && (
        <section>
          <h3>Relanzar con una nota</h3>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Qué debe cambiar en la próxima versión" />
          <button className="primary" disabled={!note.trim()} onClick={() => post('rerun', { agent: selected, note }).then((ok) => { if (ok) setNote('') })}>Relanzar agente</button>
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
