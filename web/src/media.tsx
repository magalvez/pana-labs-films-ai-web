import { useEffect, useState } from 'react'
import { blobUrl } from './api'

export const mediaKind = (name: string) => (/\.(jpe?g|png|webp)$/i.test(name) ? 'image' : /\.mp4$/i.test(name) ? 'video' : /\.mp3$/i.test(name) ? 'audio' : null)

/** Imagen, video o audio de un entregable. Se descarga con la sesión cuando hace falta mostrarlo. */
export function Media({ path, name }: { path: string; name: string }) {
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let current = '', gone = false
    setUrl(''); setFailed(false)
    blobUrl(path).then((u) => { current = u; if (gone) URL.revokeObjectURL(u); else setUrl(u) }).catch(() => setFailed(true))
    return () => { gone = true; if (current) URL.revokeObjectURL(current) }
  }, [path])
  if (failed) return <p className="bad">No se pudo cargar {name}.</p>
  if (!url) return <p className="hint">Cargando {name}…</p>
  const kind = mediaKind(name)
  if (kind === 'image') return <img className="media" src={url} alt={name} />
  if (kind === 'video') return <video className="media" src={url} controls playsInline aria-label={name} />
  return <audio className="media" src={url} controls aria-label={name} />
}
