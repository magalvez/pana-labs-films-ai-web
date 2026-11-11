import { useEffect, useMemo, useRef } from 'react'
import { H, W, createWorld, type Ev, type SchemeT } from './world'

const REPLAY_SPEED = 4

type Props = { scheme: SchemeT; events: Ev[]; replay: number; selected: string | null; onSelect: (id: string | null) => void; onReplayEnd: () => void }

export function Office({ scheme, events, replay, selected, onSelect, onReplayEnd }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const calm = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)').matches, [])
  const world = useMemo(() => createWorld(scheme, calm), [scheme, calm])
  const live = useRef({ events, cursor: 0, replaying: false, selected, hover: null as string | null })
  live.current.events = events
  live.current.selected = selected

  // Eventos nuevos: el historial viejo se aplica sin animar, lo reciente se anima.
  useEffect(() => {
    const s = live.current
    if (s.replaying) return
    let stale = false
    while (s.cursor < events.length) {
      const ev = events[s.cursor++], old = Date.now() - Date.parse(ev.ts) > 4000
      if (!old && stale) { world.settle(); stale = false }
      world.apply(ev, !old)
      stale ||= old
    }
    if (stale) world.settle()
  }, [events, world])

  // Repetición: vuelve a pasar todo el proyecto en cámara rápida.
  useEffect(() => {
    if (!replay) return
    const s = live.current
    let timer = 0
    world.reset(); world.speed = REPLAY_SPEED; s.cursor = 0; s.replaying = true
    const tick = () => {
      const ev = s.events[s.cursor]
      if (!ev) { s.replaying = false; world.speed = 1; onReplayEnd(); return }
      s.cursor++
      world.apply(ev, true)
      const next = s.events[s.cursor]
      timer = window.setTimeout(tick, next ? Math.max(30, Math.min(Date.parse(next.ts) - Date.parse(ev.ts), 1500) / REPLAY_SPEED) : 600)
    }
    tick()
    return () => { clearTimeout(timer); s.replaying = false; world.speed = 1 }
  }, [replay, world, onReplayEnd])

  useEffect(() => {
    const el = canvas.current!, ctx = el.getContext('2d')!
    let raf = 0, last = performance.now(), k = 0
    const frame = (t: number) => {
      const scale = el.clientWidth / W, want = Math.max(1, Math.min(6, Math.ceil(scale * devicePixelRatio)))
      if (want !== k) { k = want; el.width = W * k; el.height = H * k }
      ctx.setTransform(k, 0, 0, k, 0, 0)
      world.update(Math.min(0.05, (t - last) / 1000))
      last = t
      world.draw(ctx, t / 1000, live.current.hover, live.current.selected)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [world])

  const at = (e: React.MouseEvent) => {
    const r = canvas.current!.getBoundingClientRect()
    return world.actorAt(((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H)
  }

  return (
    <canvas
      ref={canvas}
      className="office"
      role="img"
      aria-label="Oficina de agentes. La lista de agentes del panel lateral ofrece la misma información."
      onMouseMove={(e) => { const a = at(e); live.current.hover = a?.id ?? null; e.currentTarget.style.cursor = a ? 'pointer' : 'default' }}
      onMouseLeave={() => { live.current.hover = null }}
      onClick={(e) => onSelect(at(e)?.id ?? null)}
    />
  )
}
