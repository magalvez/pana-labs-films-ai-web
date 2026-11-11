import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { Office } from './office/Office'
import type { Ev, SchemeT, StageT } from './office/world'

type Project = { id: string; name: string; brief: string; scheme: string; status: string; reason: string | null; budget_cap: number; spent: number }
type Step = { stage: string; agent: string; version: number; status: string; feedback: string | null }
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
  const newDialog = useRef<HTMLDialogElement>(null)
  const settingsDialog = useRef<HTMLDialogElement>(null)

  const act = useCallback(async (fn: () => Promise<unknown>) => {
    try { setError(''); await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])

  useEffect(() => {
    void act(async () => {
      const [s, st, ps] = await Promise.all([api<SchemeT[]>('/schemes'), api<Settings>('/settings'), api<Project[]>('/projects')])
      setSchemes(s); setSettings(st); setProjects(ps); setPid(ps[0]?.id ?? null)
    })
  }, [act])

  useEffect(() => {
    setEvents([]); setDetail(null); setSelected(null); setReplaying(false)
    if (!pid) return
    const source = new EventSource(`/api/projects/${pid}/events`)
    let buffer: Ev[] = [], raf = 0
    const flush = () => {
      raf = 0
      const batch = buffer
      buffer = []
      setEvents((prev) => prev.concat(batch))
      void api<Detail>(`/projects/${pid}`).then(setDetail, () => {})
    }
    source.onmessage = (m) => { buffer.push(JSON.parse(m.data)); raf ||= requestAnimationFrame(flush) }
    return () => { source.close(); cancelAnimationFrame(raf) }
  }, [pid])

  const scheme = schemes.find((s) => s.id === detail?.scheme) ?? schemes[0]
  const endReplay = useCallback(() => setReplaying(false), [])
  const post = (path: string, body?: unknown) => act(() => api(`/projects/${pid}/${path}`, 'POST', body ?? {}))

  if (!scheme || !settings) return <p className="boot">{error || 'Abriendo el estudio…'}</p>

  const stage = scheme.stages.find((s) => s.id === detail?.currentStage)
  return (
    <div className="app">
      <header className="slate">
        <div className="stripes" aria-hidden="true" />
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
            {detail?.status === 'running' && <button onClick={() => post('pause')}>Pausar</button>}
            {detail && events.length > 0 && <button disabled={replaying} onClick={() => { setReplaying(true); setReplay((n) => n + 1) }}>{replaying ? 'Reproduciendo…' : 'Ver repetición'}</button>}
            <button onClick={() => settingsDialog.current?.showModal()}>Configuración</button>
            <button className="primary" onClick={() => newDialog.current?.showModal()}>Nuevo proyecto</button>
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
            const p = await api<Project>('/projects', 'POST', { name: f.get('name'), brief: f.get('brief'), budgetCap: Number(f.get('budgetCap')) })
            setProjects((ps) => [p, ...ps]); setPid(p.id); form.reset()
          })
        }}>
          <h2>Nuevo proyecto</h2>
          <label>Nombre de la producción<input name="name" required maxLength={80} placeholder="Café Aurora, lanzamiento" /></label>
          <label>Brief del cliente<textarea name="brief" required rows={6} placeholder="Marca, producto, público, objetivo, duración y tono." /></label>
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

function Decision({ detail, stage, events, post, onReplay }: { detail: Detail; stage?: StageT; events: Ev[]; post: (path: string, body?: unknown) => Promise<void>; onReplay: () => void }) {
  const [rejecting, setRejecting] = useState(false)
  const [comment, setComment] = useState('')
  const [agents, setAgents] = useState<string[]>([])
  const [cap, setCap] = useState(detail.budget_cap * 2)
  useEffect(() => { setRejecting(false); setComment(''); setAgents([]) }, [detail.currentStage, detail.status])
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
            ? <><button onClick={() => setRejecting(false)}>Cancelar</button><button className="danger" disabled={!comment.trim()} onClick={() => post('decision', { approve: false, comment, agents })}>Devolver etapa</button></>
            : <><button onClick={() => setRejecting(true)}>Devolver con comentario</button><button className="primary" onClick={() => post('decision', { approve: true })}>{escalated ? 'Aprobar de todos modos' : 'Aprobar etapa'}</button></>}
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
              {s.feedback && <p className="bad">{s.feedback}</p>}
              <ul>{[...agent.deliverables, 'handoff.json'].map((f) => <li key={f}><a href={`/api/projects/${detail.id}/files/${stage.id}/${agent.id}/v${s.version}/${f}`} target="_blank" rel="noreferrer">{f}</a></li>)}</ul>
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
