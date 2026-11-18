import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { Markdown } from './markdown'
import { Media } from './media'

type Row = { id: string; name: string; brief: string; scheme: string; status: string; reason: string | null; brand: string | null; budget_cap: number; spent: number; simulation: boolean; created_at: string; approved: number; stages: number; runs: number; reworks: number; generation: number; master: string | null; shares: number; last_activity: string | null }
type Run = { stage: string; who: string; name: string; kind: 'agente' | 'auditor' | 'memoria'; n: number; usd: number; repeat: boolean; startedAt: string; endedAt: string }
type Costs = {
  totalUsd: number; generationUsd: number; modelUsd: number; firstPassUsd: number; reworkUsd: number; rejections: number; startedAt: string | null; lastActivityAt: string | null
  byStage: { id: string; name: string; usd: number; firstPassUsd: number; reworkUsd: number; runs: number; repeats: number }[]
  byAgent: { id: string; name: string; stage: string; kind: string; usd: number; runs: number; repeats: number }[]
  generation: { provider: string; tool: string; files: number; usd: number }[]
  runs: Run[]
}
type Share = { token: string; createdBy: string; createdAt: string; expiresAt: string; revokedAt: string | null; views: number; active: boolean }
type Act = (fn: () => Promise<unknown>) => Promise<boolean>

const STATUS: Record<string, string> = { running: 'En marcha', paused: 'En pausa', waiting_human: 'Espera decisión', done: 'Entregado', failed: 'Detenido', cancelled: 'Cancelado' }
const SCHEMES: Record<string, string> = { commercial: 'Comercial publicitario' }
const usd = (n: number) => `$${n.toFixed(2)}`
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)
const day = (ts: string) => new Date(ts).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' })
const clock = (ts: string) => new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
const TOOL: Record<string, string> = { generate_image: 'Imágenes', 'generate_video (final)': 'Tomas de video', 'generate_video (draft)': 'Pruebas de video', generate_speech: 'Locución', generate_music: 'Música', generate_sound_effect: 'Efectos de sonido' }
function span(from: string | null, to: string | null) {
  if (!from || !to) return 'sin actividad'
  const min = Math.round((Date.parse(to) - Date.parse(from)) / 60_000)
  return min < 60 ? `${min} min` : min < 2880 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${Math.round(min / 1440)} días`
}

/** Un número que sube hasta su valor al aparecer. Con movimiento reducido, aparece ya en su valor. */
function Count({ value, format }: { value: number; format: (n: number) => string }) {
  const [shown, setShown] = useState(value)
  const from = useRef(0)
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setShown(value); from.current = value; return }
    const start = from.current, t0 = performance.now()
    let frame = 0
    const tick = (t: number) => {
      const k = Math.min((t - t0) / 700, 1)
      setShown(start + (value - start) * (1 - Math.pow(1 - k, 3)))
      if (k < 1) frame = requestAnimationFrame(tick)
      else from.current = value
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [value])
  return <>{format(shown)}</>
}

/** Barra apilada: primera pasada y repeticiones. El color acompaña a la leyenda; los valores van en texto. */
function Split({ first, rework, max, label }: { first: number; rework: number; max: number; label: string }) {
  const w = (n: number) => `${max > 0 ? (n / max) * 100 : 0}%`
  return (
    <span className="split" role="img" aria-label={`${label}: ${usd(first)} en primera pasada y ${usd(rework)} en repeticiones`}>
      {first > 0 && <span className="seg first" style={{ width: w(first) }} data-tip={`Primera pasada ${usd(first)}`} />}
      {rework > 0 && <span className="seg rework" style={{ width: w(rework) }} data-tip={`Repeticiones ${usd(rework)}`} />}
    </span>
  )
}

/** El libro de producción: todas las producciones, lo que costaron y lo que se le enseña al cliente. */
export function Admin({ act, onOpen }: { act: Act; onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [sort, setSort] = useState<'recent' | 'cost' | 'rework'>('recent')

  const load = () => act(async () => setRows(await api<Row[]>('/admin/projects')))
  useEffect(() => { void load() }, [])

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out = (rows ?? []).filter((r) => (!status || r.status === status) && (!q || `${r.name} ${r.brand ?? ''}`.toLowerCase().includes(q)))
    if (sort === 'cost') out.sort((a, b) => b.spent - a.spent)
    if (sort === 'rework') out.sort((a, b) => b.reworks - a.reworks)
    return out
  }, [rows, query, status, sort])

  if (!rows) return <div className="backlot"><p className="boot">Abriendo el libro de producción…</p></div>
  // Las simulaciones se entregan con costo cero: no cuentan para el costo medio.
  const delivered = rows.filter((r) => r.status === 'done')
  const paid = delivered.filter((r) => !r.simulation)
  const total = rows.reduce((a, r) => a + r.spent, 0)
  const generation = rows.reduce((a, r) => a + r.generation, 0)
  const current = rows.find((r) => r.id === selected) ?? null

  return (
    <div className="backlot">
      <header className="backlot-head">
        <h2>Producciones</h2>
        <p>Cada producción, lo que ha costado y en qué, y lo que se le enseña al cliente.</p>
      </header>

      <dl className="marcador">
        <div><dt>Invertido en total</dt><dd><Count value={total} format={usd} /></dd><dd className="sub">{usd(generation)} en generar imagen, video y audio</dd></div>
        <div><dt>Producciones</dt><dd><Count value={rows.length} format={(n) => String(Math.round(n))} /></dd><dd className="sub">{delivered.length} entregadas, {rows.filter((r) => r.status === 'running').length} en marcha</dd></div>
        <div><dt>Costo medio por pieza entregada</dt><dd>{paid.length ? <Count value={paid.reduce((a, r) => a + r.spent, 0) / paid.length} format={usd} /> : 'Sin datos'}</dd><dd className="sub">{paid.length ? `sobre ${paid.length} pieza${paid.length > 1 ? 's' : ''} real${paid.length > 1 ? 'es' : ''}, sin contar simulaciones` : 'aún no hay piezas reales entregadas'}</dd></div>
        <div><dt>Esperan tu decisión</dt><dd><Count value={rows.filter((r) => r.status === 'waiting_human').length} format={(n) => String(Math.round(n))} /></dd><dd className="sub">{rows.filter((r) => r.status === 'failed').length} detenidas por un error</dd></div>
      </dl>

      <div className="filters">
        <label>Buscar<input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nombre o cliente" /></label>
        <label>Estado<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todos</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>Orden<select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}><option value="recent">Más recientes</option><option value="cost">Mayor costo</option><option value="rework">Más repeticiones</option></select></label>
      </div>

      <div className={current ? 'ledger open' : 'ledger'}>
        <ul className="reel-list" aria-label="Producciones">
          {!list.length && <li className="hint">{rows.length ? 'Ninguna producción coincide con el filtro.' : 'Todavía no hay producciones. Crea la primera desde el estudio.'}</li>}
          {list.map((r) => (
            <li key={r.id}>
              <button className="strip" aria-pressed={r.id === selected} onClick={() => setSelected(r.id === selected ? null : r.id)}>
                <span className="holes" aria-hidden="true" />
                <span className="strip-body">
                  <span className="strip-title">{r.name}</span>
                  <span className="strip-meta">{r.brand ?? 'Sin cliente'}, {day(r.created_at)}</span>
                  <span className="strip-stages" role="img" aria-label={`${r.approved} de ${r.stages} etapas aprobadas`}>{Array.from({ length: r.stages }, (_, i) => <i key={i} className={i < r.approved ? 'on' : ''} />)}</span>
                </span>
                <span className="strip-side">
                  <span className={`status ${r.status}`}>{STATUS[r.status] ?? r.status}</span>
                  <span className="strip-cost">{usd(r.spent)}<small> de {usd(r.budget_cap)}</small></span>
                  <span className="strip-tags">{r.simulation && <em>simulación</em>}{r.reworks > 0 && <em>{r.reworks === 1 ? '1 repetición' : `${r.reworks} repeticiones`}</em>}{r.shares > 0 && <em>compartida</em>}</span>
                </span>
                <span className="holes" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        {current && <Sheet key={current.id} row={current} act={act} onOpen={onOpen} onChanged={load} onDeleted={() => { setSelected(null); void load() }} />}
      </div>
    </div>
  )
}

/** La hoja de costos de una producción, con sus acciones. */
function Sheet({ row, act, onOpen, onChanged, onDeleted }: { row: Row; act: Act; onOpen: (id: string) => void; onChanged: () => void; onDeleted: () => void }) {
  const [costs, setCosts] = useState<Costs | null>(null)
  const [shares, setShares] = useState<Share[]>([])
  const [report, setReport] = useState<string | null>(null)
  const [days, setDays] = useState(14)
  const [busy, setBusy] = useState('')
  const [copied, setCopied] = useState('')
  const [confirm, setConfirm] = useState('')
  const [cap, setCap] = useState(Math.ceil(row.budget_cap * 1.5))
  const [brand, setBrand] = useState<{ kit: string; files: string[] } | null>(null)
  // La biblioteca de marca es del cliente y se comparte entre sus proyectos: aquí se ve como está hoy.
  useEffect(() => {
    setBrand(null)
    if (!row.brand) return
    let gone = false
    const name = row.brand
    void Promise.all([api<{ name: string; kit: string }[]>('/brands'), api<string[]>(`/brands/${encodeURIComponent(name)}/assets`)])
      .then(([all, files]) => { if (!gone) setBrand({ kit: all.find((b) => b.name === name)?.kit ?? '', files }) }).catch(() => {})
    return () => { gone = true }
  }, [row.id, row.brand])

  const reload = () => act(async () => {
    const [c, s] = await Promise.all([api<Costs>(`/admin/projects/${row.id}/costs`), api<Share[]>(`/admin/projects/${row.id}/shares`)])
    setCosts(c); setShares(s)
  })
  useEffect(() => { void reload() }, [row.id, row.status, row.spent])

  const run = (label: string, fn: () => Promise<unknown>) => { setBusy(label); return act(fn).finally(() => setBusy('')) }
  const post = (path: string, body?: unknown) => run(path, async () => { await api(`/projects/${row.id}/${path}`, 'POST', body ?? {}); onChanged() })
  const link = (token: string) => `${location.origin}/p/${token}`
  const copy = (token: string) => navigator.clipboard.writeText(link(token)).then(() => { setCopied(token); setTimeout(() => setCopied(''), 2000) }).catch(() => {})

  const agents = useMemo(() => {
    if (!costs) return []
    return costs.byAgent.map((a) => {
      const mine = costs.runs.filter((r) => r.who === a.id && r.stage === a.stage)
      return { ...a, firstPassUsd: mine.filter((r) => !r.repeat).reduce((s, r) => s + r.usd, 0), reworkUsd: mine.filter((r) => r.repeat).reduce((s, r) => s + r.usd, 0) }
    })
  }, [costs])
  const stageName = (id: string) => costs?.byStage.find((s) => s.id === id)?.name ?? id
  const maxStage = Math.max(...(costs?.byStage.map((s) => s.usd) ?? [0]), 0.01)
  const maxAgent = Math.max(...agents.map((a) => a.usd), 0.01)

  return (
    <article className="cost-sheet" aria-label={`Hoja de costos de ${row.name}`}>
      <header>
        <p className="kicker">Hoja de costos</p>
        <h3>{row.name}</h3>
        <p className="meta">{row.brand ?? 'Sin cliente'}. Creada el {day(row.created_at)}. <span className={`status ${row.status}`}>{STATUS[row.status] ?? row.status}</span>{row.reason && row.status === 'failed' ? `: ${row.reason}` : ''}</p>
        <div className="sheet-actions">
          <button className="primary" onClick={() => onOpen(row.id)}>Abrir en el estudio</button>
          {row.status === 'running' && <button disabled={!!busy} onClick={() => post('pause')}>Pausar</button>}
          {(row.status === 'paused' || row.status === 'failed') && <button disabled={!!busy} onClick={() => post('resume')}>{row.status === 'failed' ? 'Reintentar' : 'Reanudar'}</button>}
          {!['done', 'cancelled'].includes(row.status) && <button disabled={!!busy} onClick={() => post('cancel')}>Cancelar</button>}
        </div>
      </header>

      {row.master && <div className="sheet-video"><Media path={`/projects/${row.id}/files/${row.master}`} name="master.mp4" /></div>}

      <section className="order">
        <h4>El encargo</h4>
        <dl>
          <div><dt>Nombre</dt><dd>{row.name}</dd></div>
          <div><dt>Cliente</dt><dd>{row.brand ?? 'Sin cliente'}</dd></div>
          <div><dt>Tipo de pieza</dt><dd>{SCHEMES[row.scheme] ?? row.scheme}</dd></div>
          <div><dt>Modo</dt><dd>{row.simulation ? 'Simulación, no gasta' : 'Real'}</dd></div>
          <div><dt>Tope de presupuesto</dt><dd>{usd(row.budget_cap)}</dd></div>
          <div><dt>Creada</dt><dd>{new Date(row.created_at).toLocaleString('es', { dateStyle: 'long', timeStyle: 'short' })}</dd></div>
        </dl>
        <h5>Brief</h5>
        <p className="order-text">{row.brief}</p>
        {row.brand && <>
          <h5>Biblioteca de marca de {row.brand}</h5>
          <p className="order-text">{brand ? brand.kit || 'Sin texto guardado.' : 'Cargando…'}</p>
          <h5>Archivos reales del cliente</h5>
          {brand?.files.length ? <ul className="order-files">{brand.files.map((f) => <li key={f}>{f}</li>)}</ul> : <p>{brand ? 'Ninguno.' : 'Cargando…'}</p>}
          <p className="hint">La biblioteca y los archivos son del cliente y se comparten entre sus producciones: se muestran como están hoy.</p>
        </>}
      </section>

      {!costs ? <p className="hint">Sumando…</p> : (
        <>
          <section className="hero">
            <p className="hero-number"><Count value={costs.totalUsd} format={usd} /></p>
            <p className="hero-label">gastados de un tope de {usd(row.budget_cap)} ({pct(costs.totalUsd, row.budget_cap)} %)</p>
            <progress value={Math.min(costs.totalUsd, row.budget_cap)} max={row.budget_cap} aria-label="Presupuesto usado" />
            <dl className="facts">
              <div><dt>Agentes de Claude</dt><dd>{usd(costs.modelUsd)}</dd></div>
              <div><dt>Generación</dt><dd>{usd(costs.generationUsd)}</dd></div>
              <div><dt>En repeticiones</dt><dd>{usd(costs.reworkUsd)}<small> {pct(costs.reworkUsd, costs.totalUsd)} %</small></dd></div>
              <div><dt>Rechazos del auditor</dt><dd>{costs.rejections}</dd></div>
              <div><dt>Tiempo de producción</dt><dd>{span(costs.startedAt, costs.lastActivityAt)}</dd></div>
            </dl>
            {row.status === 'paused' && row.reason === 'budget' && (
              <p className="raise">
                <label>Tope nuevo en dólares<input type="number" min={Math.ceil(row.spent) + 1} max={10000} value={cap} onChange={(e) => setCap(Number(e.target.value))} /></label>
                <button className="primary" disabled={!!busy || !(cap > row.spent)} onClick={() => post('resume', { budgetCap: cap })}>Subir tope y reanudar</button>
              </p>
            )}
          </section>

          <section>
            <h4>Por etapa</h4>
            <p className="legend"><span className="key first" />Primera pasada<span className="key rework" />Repeticiones</p>
            <table className="bars">
              <thead><tr><th scope="col">Etapa</th><th scope="col"><span className="sr">Reparto</span></th><th scope="col" className="num">Costo</th><th scope="col" className="num">Ejecuciones</th></tr></thead>
              <tbody>{costs.byStage.map((s) => (
                <tr key={s.id}><th scope="row">{s.name}</th><td className="bar"><Split first={s.firstPassUsd} rework={s.reworkUsd} max={maxStage} label={s.name} /></td><td className="num">{usd(s.usd)}</td><td className="num">{s.runs}{s.repeats > 0 && <small> ({s.repeats} rep.)</small>}</td></tr>
              ))}</tbody>
            </table>
          </section>

          <section>
            <h4>Por agente</h4>
            <table className="bars">
              <thead><tr><th scope="col">Agente</th><th scope="col"><span className="sr">Reparto</span></th><th scope="col" className="num">Costo</th><th scope="col" className="num">Veces</th></tr></thead>
              <tbody>{agents.map((a) => (
                <tr key={`${a.stage}/${a.id}`}><th scope="row">{a.name}<small>{a.kind === 'memoria' ? 'Para el cliente' : stageName(a.stage)}</small></th><td className="bar"><Split first={a.firstPassUsd} rework={a.reworkUsd} max={maxAgent} label={a.name} /></td><td className="num">{usd(a.usd)}</td><td className="num">{a.runs}</td></tr>
              ))}</tbody>
            </table>
          </section>

          <section>
            <h4>Generación</h4>
            {!costs.generation.length ? <p className="hint">Esta producción no ha pagado ninguna generación.</p> : (
              <table className="plain">
                <thead><tr><th scope="col">Qué</th><th scope="col">Proveedor</th><th scope="col" className="num">Archivos</th><th scope="col" className="num">Costo</th></tr></thead>
                <tbody>{costs.generation.map((g) => <tr key={`${g.provider}/${g.tool}`}><th scope="row">{TOOL[g.tool] ?? g.tool}</th><td>{g.provider}</td><td className="num">{g.files}</td><td className="num">{usd(g.usd)}</td></tr>)}</tbody>
              </table>
            )}
          </section>

          <details className="log">
            <summary>Bitácora: {costs.runs.length} ejecuciones</summary>
            <table className="plain">
              <thead><tr><th scope="col">Hora</th><th scope="col">Quién</th><th scope="col">Vuelta</th><th scope="col" className="num">Costo</th></tr></thead>
              <tbody>{costs.runs.map((r, i) => <tr key={i} className={r.repeat ? 'repeat' : ''}><td>{clock(r.startedAt)}</td><th scope="row">{r.name}</th><td>{r.kind === 'auditor' ? `Auditoría ${r.n}` : r.kind === 'memoria' ? 'Memoria' : `Versión ${r.n}`}{r.repeat && ' (repetición)'}</td><td className="num">{usd(r.usd)}</td></tr>)}</tbody>
            </table>
          </details>
        </>
      )}

      <section className="client">
        <h4>Para el cliente</h4>
        {!row.master ? <p className="hint">Cuando la pieza esté montada podrás compartirla aquí con un enlace de solo lectura.</p> : (
          <>
            <p>Un enlace abre una página con la pieza, sus versiones y la memoria de producción. No pide cuenta y no enseña costos ni nada interno.</p>
            <p className="share-new">
              <label>Dura<select value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={3}>3 días</option><option value={7}>7 días</option><option value={14}>14 días</option><option value={30}>30 días</option><option value={90}>90 días</option></select></label>
              <button className="primary" disabled={!!busy} onClick={() => run('share', async () => { const s = await api<{ token: string }>(`/admin/projects/${row.id}/shares`, 'POST', { days }); await reload(); onChanged(); void copy(s.token) })}>{busy === 'share' ? 'Preparando la vista previa…' : 'Crear enlace'}</button>
            </p>
            {shares.length > 0 && (
              <ul className="shares">{shares.map((s) => (
                <li key={s.token} className={s.active ? '' : 'off'}>
                  <a href={link(s.token)} target="_blank" rel="noreferrer">{link(s.token).replace(/^https?:\/\//, '').slice(0, 44)}…</a>
                  <span>{s.active ? `Vence el ${day(s.expiresAt)}` : s.revokedAt ? 'Revocado' : 'Vencido'}, {s.views} visita{s.views === 1 ? '' : 's'}</span>
                  {s.active && <span className="share-actions"><button onClick={() => copy(s.token)}>{copied === s.token ? 'Copiado' : 'Copiar'}</button><button disabled={!!busy} onClick={() => run('revoke', async () => { await api(`/admin/projects/${row.id}/shares/${s.token}`, 'DELETE'); await reload(); onChanged() })}>Revocar</button></span>}
                </li>
              ))}</ul>
            )}
            <p className="share-new">
              <button disabled={!!busy} onClick={() => run('report', async () => setReport((await api<{ markdown: string }>(`/admin/projects/${row.id}/report`)).markdown))}>{busy === 'report' ? 'Abriendo…' : 'Ver la memoria de producción'}</button>
              <button disabled={!!busy} onClick={() => run('rewrite', async () => { setReport((await api<{ markdown: string }>(`/admin/projects/${row.id}/report`, 'POST')).markdown); onChanged() })}>{busy === 'rewrite' ? 'Escribiendo…' : 'Volver a escribirla'}</button>
            </p>
            {report !== null && <div className="memo"><Markdown text={report} /></div>}
          </>
        )}
      </section>

      <section className="danger-zone">
        <h4>Borrar la producción</h4>
        <p>Se borran sus archivos, sus costos y sus enlaces. No se puede deshacer. {row.status === 'running' && 'Pausa o cancela la producción antes.'}</p>
        <p className="share-new">
          <label>Escribe «{row.name}» para confirmar<input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" /></label>
          <button className="danger" disabled={confirm !== row.name || row.status === 'running' || !!busy} onClick={() => run('delete', async () => { await api(`/admin/projects/${row.id}`, 'DELETE', { confirm }); onDeleted() })}>Borrar para siempre</button>
        </p>
      </section>
    </article>
  )
}
