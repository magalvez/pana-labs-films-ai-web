import { useEffect, useRef, useState } from 'react'
import './explore.css'
import { Markdown } from './markdown'

type Video = { index: number; label: string; seconds: number | null; width: number | null; height: number | null }
type Mood = { idea: string; boards: { title: string; note: string; images: number[] }[] }
type Share = { name: string; brand: string | null; expiresAt: string; report: string; videos: Video[]; moodboard?: Mood }

const day = (ts: string) => new Date(ts).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' })

/** La sala de proyección: lo que ve un cliente con su enlace. Sin cuenta, sin menús, solo la pieza y su memoria. */
export function Preview({ token }: { token: string }) {
  const [share, setShare] = useState<Share | null>(null)
  const [error, setError] = useState('')
  const [current, setCurrent] = useState(0)

  useEffect(() => {
    fetch(`/api/public/${token}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error ?? 'No se pudo abrir la vista previa')
        setShare(body)
        document.title = `${body.name} · Pana Films`
      })
      .catch((e) => setError(e.message))
  }, [token])

  if (error) return (
    <main className="screening closed">
      <div className="stripes" aria-hidden="true" />
      <h1>Función terminada</h1>
      <p>{error}</p>
    </main>
  )
  if (!share) return <main className="screening closed"><p>Apagando las luces…</p></main>

  // Antes de que exista la pieza, el enlace enseña el moodboard: la idea y las imágenes que definen el look.
  if (!share.videos.length && share.moodboard?.boards.length) return <Moodboard token={token} share={share} mood={share.moodboard} />

  const video = share.videos[current] ?? share.videos[0]
  const src = (v: Video) => `/api/public/${token}/video/${v.index}`
  const tall = Boolean(video?.width && video.height && video.height > video.width)
  return (
    <main className="screening">
      <div className="stripes" aria-hidden="true" />
      <header className="marquee">
        <p className="house">Pana Films presenta</p>
        <h1>{share.name}</h1>
        {share.brand && <p className="for">para {share.brand}</p>}
      </header>

      {video && (
        <section className="screen" aria-label="La pieza">
          <div className={tall ? 'frame tall' : 'frame'}>
            {/* La clave fuerza a recargar el reproductor al cambiar de versión. */}
            <video key={video.index} src={src(video)} controls playsInline preload="metadata" />
          </div>
          {share.videos.length > 1 && (
            <div className="reels" role="group" aria-label="Versiones">
              {share.videos.map((v, i) => (
                <button key={v.index} aria-pressed={i === current} onClick={() => setCurrent(i)}>{v.label}{v.seconds ? `, ${Math.round(v.seconds)} s` : ''}</button>
              ))}
            </div>
          )}
          <p className="downloads">
            {share.videos.map((v) => <a key={v.index} href={src(v)} download={`${share.name} - ${v.label}.mp4`}>Descargar {v.label.toLowerCase()}</a>)}
          </p>
        </section>
      )}

      <article className="programme">
        <header>
          <p className="kicker">Memoria de producción</p>
          <p className="title">{share.name}</p>
        </header>
        <Markdown text={share.report} />
        <footer>
          <p>Vista previa disponible hasta el {day(share.expiresAt)}.</p>
          <button onClick={() => window.print()}>Imprimir o guardar como PDF</button>
        </footer>
      </article>
    </main>
  )
}

/** El moodboard: una portada con la primera imagen, la idea y cada tablero con lo elegido. */
function Moodboard({ token, share, mood }: { token: string; share: Share; mood: Mood }) {
  const [zoom, setZoom] = useState<number | null>(null)
  const grid = useRef<HTMLDivElement>(null)
  const src = (i: number) => `/api/public/${token}/image/${i}`
  const total = mood.boards.reduce((n, b) => n + b.images.length, 0)
  // Cada imagen aparece cuando entra en pantalla.
  useEffect(() => {
    const seen = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); seen.unobserve(e.target) } }, { threshold: 0.12 })
    grid.current?.querySelectorAll('.mood-grid button').forEach((el) => seen.observe(el))
    return () => seen.disconnect()
  }, [])
  useEffect(() => {
    if (zoom === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoom(null)
      if (e.key === 'ArrowRight') setZoom((z) => (z === null ? z : (z + 1) % total))
      if (e.key === 'ArrowLeft') setZoom((z) => (z === null ? z : (z - 1 + total) % total))
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [zoom, total])
  return (
    <main className="screening">
      <div className="stripes" aria-hidden="true" />
      <header className="mood-hero">
        <img src={src(mood.boards[0].images[0])} alt="" />
        <div>
          <p className="house">Pana Films presenta · el look</p>
          <h1>{share.name}</h1>
          {share.brand && <p className="for">para {share.brand}</p>}
        </div>
      </header>
      {mood.idea && <p className="mood-idea">{mood.idea}</p>}
      <div ref={grid}>
        {mood.boards.map((b) => (
          <section key={b.title + b.images[0]} className="mood-board">
            <header><h2>{b.title}</h2>{b.note && <p>{b.note}</p>}</header>
            <div className="mood-grid">
              {b.images.map((i, n) => <button key={i} style={{ transitionDelay: `${n * 110}ms` }} aria-label={`Ampliar ${b.title}, imagen ${n + 1}`} onClick={() => setZoom(i)}><img src={src(i)} alt={`${b.title}, imagen ${n + 1}`} loading="lazy" /></button>)}
            </div>
          </section>
        ))}
      </div>
      <footer className="mood-foot">
        <p>Estas imágenes son exploración del look, hechas con inteligencia artificial generativa: definen la dirección, no son cuadros finales del comercial. Disponible hasta el {day(share.expiresAt)}.</p>
        <button onClick={() => window.print()}>Imprimir o guardar como PDF</button>
      </footer>
      {zoom !== null && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label="Imagen ampliada" onClick={() => setZoom(null)}>
          <figure onClick={(e) => e.stopPropagation()}>
            <img key={zoom} src={src(zoom)} alt="" />
            <figcaption>
              <span>{zoom + 1} de {total}</span>
              <button onClick={() => setZoom((zoom - 1 + total) % total)}>Anterior</button>
              <button onClick={() => setZoom((zoom + 1) % total)}>Siguiente</button>
              <button autoFocus onClick={() => setZoom(null)}>Cerrar</button>
            </figcaption>
          </figure>
        </div>
      )}
    </main>
  )
}
