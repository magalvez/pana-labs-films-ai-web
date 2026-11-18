import { useEffect, useState } from 'react'
import { Markdown } from './markdown'

type Video = { index: number; label: string; seconds: number | null; width: number | null; height: number | null }
type Share = { name: string; brand: string | null; expiresAt: string; report: string; videos: Video[] }

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
