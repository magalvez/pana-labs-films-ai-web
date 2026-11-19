import { useEffect, useMemo, useRef, useState } from 'react'
import { api, blobUrl } from './api'
import './explore.css'

type Image = { file: string; selected: boolean }
type Board = { id: string; title: string; prompt: string; note: string; aspect: string; withProduct: boolean; images: Image[] }
type Exploration = { idea: string; boards: Board[]; usdPerImage: number; imageModel: string; productPhotos: number; failed?: number }
type Act = (fn: () => Promise<unknown>) => Promise<boolean>
type Project = { id: string; name: string; brand: string | null; spent: number; budget_cap: number; simulation: boolean }

const usd = (n: number) => `$${n.toFixed(2)}`
const ASPECTS: Record<string, string> = { '16:9': 'Horizontal 16:9', '3:4': 'Retrato 3:4', '1:1': 'Cuadrado 1:1', '9:16': 'Vertical 9:16' }
const ratio = (a: string) => a.replace(':', ' / ')

// ponytail: las imágenes descargadas se guardan en memoria hasta recargar la página; son pocas y pequeñas.
const blobs = new Map<string, Promise<string>>()
const load = (path: string) => { let p = blobs.get(path); if (!p) { p = blobUrl(path); blobs.set(path, p); p.catch(() => blobs.delete(path)) } return p }

/** Una imagen del proyecto, descargada con la sesión una sola vez aunque se muestre en varios sitios. */
function Shot({ pid, file, alt }: { pid: string; file: string; alt: string }) {
  const [url, setUrl] = useState('')
  useEffect(() => { let gone = false; setUrl(''); load(`/projects/${pid}/files/${file}`).then((u) => { if (!gone) setUrl(u) }).catch(() => {}); return () => { gone = true } }, [pid, file])
  return url ? <img src={url} alt={alt} /> : <span className="blank" aria-label={`Cargando ${alt}`} />
}

/** Sala de exploración: se prueban looks con imágenes fijas, se eligen las referencias y recién entonces arranca la producción. */
export function Explore({ project, admin, act, onChanged, onRaise }: { project: Project; admin: boolean; act: Act; onChanged: () => void; onRaise: () => void }) {
  const pid = project.id
  const [x, setX] = useState<Exploration | null>(null)
  const [busy, setBusy] = useState<Record<string, number>>({})
  const [thinking, setThinking] = useState(false)
  const [zoom, setZoom] = useState<number | null>(null)
  const [link, setLink] = useState('')
  const [copied, setCopied] = useState(false)
  const [launching, setLaunching] = useState(false)
  // Las imágenes que ya estaban al entrar no se "revelan" otra vez; solo las recién generadas.
  const seen = useRef<Set<string> | null>(null)
  const base = `/projects/${pid}/exploration`

  // Del servidor se toman los tableros que existen y sus imágenes; los textos en pantalla son los de quien escribe,
  // para que una respuesta que tarda no borre lo tecleado mientras tanto.
  const take = (next: Exploration) => setX((old) => (!old ? next : {
    ...old, ...next, idea: old.idea || next.idea,
    boards: next.boards.map((b) => { const mine = old.boards.find((o) => o.id === b.id); return mine ? { ...b, title: mine.title, prompt: mine.prompt, note: mine.note, aspect: mine.aspect, withProduct: mine.withProduct } : b }),
  }))
  const reload = () => act(async () => { const got = await api<Exploration>(base); setX((old) => old && { ...old, boards: old.boards.map((b) => ({ ...b, images: got.boards.find((o) => o.id === b.id)?.images ?? b.images })) }) })
  useEffect(() => {
    seen.current = null; setX(null); setLink('')
    void act(async () => { const got = await api<Exploration>(base); seen.current = new Set(got.boards.flatMap((b) => b.images.map((i) => i.file))); setX(got) })
  }, [pid])

  const all = useMemo(() => (x?.boards ?? []).flatMap((b) => b.images.map((i) => ({ ...i, board: b.title }))), [x])
  const chosen = all.filter((i) => i.selected)
  const left = project.budget_cap - project.spent

  const edit = (id: string, patch: Partial<Board>) => setX((old) => old && { ...old, boards: old.boards.map((b) => (b.id === id ? { ...b, ...patch } : b)) })
  const save = (next: { idea: string; boards: Board[] }) => act(async () => take(await api<Exploration>(base, 'PUT', { idea: next.idea, boards: next.boards.map(({ images: _images, ...text }) => text) })))
  const suggest = () => { setThinking(true); void act(async () => { take(await api<Exploration>(`${base}/suggest`, 'POST', {})); onChanged() }).finally(() => setThinking(false)) }
  const generate = (b: Board) => {
    setBusy((m) => ({ ...m, [b.id]: 4 }))
    void act(async () => {
      // Los textos se guardan antes de generar: la imagen sale del prompt que se ve en pantalla.
      await api(base, 'PUT', { idea: x!.idea, boards: x!.boards.map(({ images: _images, ...text }) => text) })
      const got = await api<Exploration>(`${base}/boards/${b.id}/generate`, 'POST', { count: 4 })
      take(got); onChanged()
      if (got.failed) throw new Error(`${got.failed} de las 4 opciones no se pudo generar. Las demás ya están en el tablero.`)
    }).finally(() => setBusy((m) => ({ ...m, [b.id]: 0 })))
  }
  const pick = (i: Image) => {
    // Se marca al instante y se confirma con el servidor.
    setX((old) => old && { ...old, boards: old.boards.map((b) => ({ ...b, images: b.images.map((im) => (im.file === i.file ? { ...im, selected: !i.selected } : im)) })) })
    void act(async () => take(await api<Exploration>(`${base}/select`, 'POST', { file: i.file, selected: !i.selected }))).then((ok) => { if (!ok) void reload() })
  }
  const share = () => act(async () => { const s = await api<{ token: string }>(`${base}/share`, 'POST', {}); setLink(`${location.origin}/p/${s.token}`); setCopied(false) })
  const start = () => {
    setLaunching(true)
    // La claqueta se cierra y recién entonces arranca: si falla, se vuelve a la sala.
    window.setTimeout(() => void act(async () => { await api(`/projects/${pid}/start`, 'POST', {}); onChanged() }).then((ok) => { if (!ok) setLaunching(false) }), 1300)
  }

  useEffect(() => {
    if (zoom === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoom(null)
      if (e.key === 'ArrowRight') setZoom((z) => (z === null ? z : (z + 1) % all.length))
      if (e.key === 'ArrowLeft') setZoom((z) => (z === null ? z : (z - 1 + all.length) % all.length))
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [zoom, all.length])

  if (!x) return <main className="darkroom"><p className="darkroom-wait">Encendiendo la luz roja…</p></main>
  const zoomed = zoom === null ? null : all[zoom]

  return (
    <main className={Object.values(busy).some(Boolean) || thinking ? 'darkroom developing' : 'darkroom'}>
      <header className="darkroom-head">
        <div>
          <p className="kicker">Antes de rodar · {project.name}</p>
          <h2>Sala de exploración</h2>
          <p className="lead">Prueba el look con imágenes fijas, elige las que definen el comercial y enséñaselas al cliente. Lo que elijas llega a todos los agentes como referencia, desde Strategy.</p>
        </div>
        <dl className="meter" aria-label="Presupuesto de la exploración">
          <div><dt>Gastado</dt><dd>{usd(project.spent)}</dd></div>
          <div><dt>Queda del tope</dt><dd className={left < x.usdPerImage * 4 ? 'low' : ''}>{usd(Math.max(left, 0))}</dd></div>
          <div><dt>4 opciones</dt><dd>{project.simulation ? 'Simulación' : usd(x.usdPerImage * 4)}</dd></div>
          {left < x.usdPerImage * 4 && !project.simulation && <button onClick={onRaise}>+ Tope</button>}
        </dl>
      </header>

      <section className="idea">
        <label>La idea, en dos o tres frases. La verá el cliente en el moodboard.
          <textarea rows={2} maxLength={800} value={x.idea} placeholder="Una mañana cualquiera se vuelve especial cuando…" onChange={(e) => setX({ ...x, idea: e.target.value })} onBlur={() => save(x)} />
        </label>
        <p className="idea-actions">
          <button className="primary" disabled={thinking} onClick={suggest}>{thinking ? 'Leyendo el brief…' : x.boards.length ? 'Proponer más tableros' : 'Proponer tableros a partir del brief'}</button>
          <button disabled={x.boards.length >= 8} onClick={() => save({ idea: x.idea, boards: [...x.boards, { id: '', title: 'Tablero nuevo', prompt: '', note: '', aspect: '16:9', withProduct: false, images: [] }] })}>Añadir un tablero vacío</button>
        </p>
      </section>

      {!x.boards.length && !thinking && (
        <section className="darkroom-empty">
          <h3>Todavía no hay nada revelado</h3>
          <p>Pide una propuesta y el estudio leerá el brief para sugerir qué explorar: la persona protagonista, la locación y el look. Cada tablero trae su descripción lista para editar.</p>
        </section>
      )}
      {thinking && !x.boards.length && <section className="darkroom-empty"><h3 className="pulse">Leyendo el brief…</h3><p>En unos segundos aparecen los tableros propuestos.</p></section>}

      {x.boards.map((b) => (
        <section key={b.id} className={busy[b.id] ? 'board working' : 'board'} aria-label={`Tablero ${b.title}`}>
          <div className="board-brief">
            <input className="board-title" aria-label="Nombre del tablero" maxLength={60} value={b.title} onChange={(e) => edit(b.id, { title: e.target.value })} onBlur={() => save(x)} />
            <label>Qué quieres ver. En inglés suele salir mejor.
              <textarea rows={5} maxLength={1500} value={b.prompt} onChange={(e) => edit(b.id, { prompt: e.target.value })} onBlur={() => save(x)} />
            </label>
            <label>Qué deben respetar los agentes de la imagen elegida
              <input type="text" maxLength={400} value={b.note} placeholder="Es la protagonista en todos los planos" onChange={(e) => edit(b.id, { note: e.target.value })} onBlur={() => save(x)} />
            </label>
            <div className="board-options">
              <label>Formato
                <select value={b.aspect} onChange={(e) => { const next = { ...x, boards: x.boards.map((o) => (o.id === b.id ? { ...o, aspect: e.target.value } : o)) }; setX(next); void save(next) }}>
                  {Object.entries(ASPECTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              {x.productPhotos > 0 && (
                <label className="tick"><input type="checkbox" checked={b.withProduct} onChange={(e) => { const next = { ...x, boards: x.boards.map((o) => (o.id === b.id ? { ...o, withProduct: e.target.checked } : o)) }; setX(next); void save(next) }} />Usar las {x.productPhotos} fotos reales del producto como referencia</label>
              )}
            </div>
            <p className="board-actions">
              <button className="primary" disabled={Boolean(busy[b.id]) || b.prompt.trim().length < 10} onClick={() => generate(b)}>{busy[b.id] ? 'Revelando…' : b.images.length ? 'Generar 4 opciones más' : 'Generar 4 opciones'}</button>
              <button className="quiet" disabled={Boolean(busy[b.id])} onClick={() => save({ idea: x.idea, boards: x.boards.filter((o) => o.id !== b.id) })}>Quitar tablero</button>
            </p>
          </div>
          <ul className="sheet-grid">
            {b.images.map((i, n) => (
              <li key={i.file} className={[i.selected ? 'picked' : '', seen.current?.has(i.file) ? '' : 'fresh'].join(' ')} style={{ aspectRatio: ratio(b.aspect), animationDelay: `${(n % 4) * 140}ms` }}>
                <button className="frame" aria-pressed={i.selected} aria-label={`${i.selected ? 'Quitar' : 'Elegir'} la opción ${n + 1} de ${b.title}`} onClick={() => pick(i)}>
                  <Shot pid={pid} file={i.file} alt={`${b.title}, opción ${n + 1}`} />
                  {i.selected && <span className="stamp" aria-hidden="true">Elegida</span>}
                </button>
                <button className="loupe" aria-label={`Ampliar la opción ${n + 1} de ${b.title}`} onClick={() => setZoom(all.findIndex((a) => a.file === i.file))}>Ampliar</button>
              </li>
            ))}
            {Array.from({ length: busy[b.id] ?? 0 }, (_, n) => <li key={`wait${n}`} className="bath" style={{ aspectRatio: ratio(b.aspect), animationDelay: `${n * 180}ms` }}><span>Revelando…</span></li>)}
            {!b.images.length && !busy[b.id] && <li className="unexposed" style={{ aspectRatio: ratio(b.aspect) }}><span>Sin exponer</span></li>}
          </ul>
        </section>
      ))}

      <footer className="filmstrip" aria-label="Lo elegido">
        <ol className="reel">
          {chosen.map((i) => <li key={i.file}><button aria-label={`Ampliar ${i.board}`} onClick={() => setZoom(all.findIndex((a) => a.file === i.file))}><Shot pid={pid} file={i.file} alt={i.board} /></button></li>)}
          {!chosen.length && <li className="reel-empty">Toca una imagen para elegirla. Las elegidas serán las referencias de la producción.</li>}
        </ol>
        <div className="reel-actions">
          {link
            ? <span className="reel-link"><input readOnly value={link} aria-label="Enlace para el cliente" onFocus={(e) => e.currentTarget.select()} /><button onClick={() => navigator.clipboard.writeText(link).then(() => setCopied(true)).catch(() => {})}>{copied ? 'Copiado' : 'Copiar'}</button></span>
            : admin && <button disabled={!chosen.length} onClick={share}>Enlace del moodboard para el cliente</button>}
          <button className="primary action" disabled={launching || Object.values(busy).some(Boolean)} onClick={start}>{chosen.length ? `Iniciar producción con ${chosen.length} referencia${chosen.length > 1 ? 's' : ''}` : 'Saltar e iniciar producción'}</button>
        </div>
      </footer>

      {zoomed && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label={zoomed.board} onClick={() => setZoom(null)}>
          <figure onClick={(e) => e.stopPropagation()}>
            <Shot key={zoomed.file} pid={pid} file={zoomed.file} alt={zoomed.board} />
            <figcaption>
              <span>{zoomed.board} · {zoom! + 1} de {all.length}</span>
              <button onClick={() => setZoom((zoom! - 1 + all.length) % all.length)}>Anterior</button>
              <button onClick={() => setZoom((zoom! + 1) % all.length)}>Siguiente</button>
              <button className="primary" onClick={() => pick(zoomed)}>{zoomed.selected ? 'Quitar de lo elegido' : 'Elegir esta'}</button>
              <button autoFocus onClick={() => setZoom(null)}>Cerrar</button>
            </figcaption>
          </figure>
        </div>
      )}

      {launching && (
        <div className="clapper" role="status" aria-label="Iniciando la producción">
          <div className="clapper-board">
            <div className="clapper-arm" aria-hidden="true" />
            <p className="clapper-scene">{project.name}</p>
            <p className="clapper-action">¡Acción!</p>
          </div>
        </div>
      )}
    </main>
  )
}
