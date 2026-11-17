// La oficina: estado derivado de los eventos del motor y su dibujo en pixel art.
export type Ev = { id: number; projectId: string; ts: string; type: string; data: any }
export type AgentT = { id: string; name: string; deliverables: string[] }
export type StageT = { id: string; name: string; gate: string; auditor: { id: string; name: string }; agents: AgentT[] }
export type SchemeT = { id: string; name: string; stages: StageT[] }

export const W = 648
export const H = 352
const RW = 216, RH = 176, LANE = 202, BOTTOM = 154

type Pt = { x: number; y: number }
type Door = 'east' | 'south' | 'west'
type Look = { skin: string; hair: string; style: number; shirt: string }
export type Actor = {
  id: string; name: string; kind: 'agent' | 'auditor' | 'orch' | 'human'; room: Room
  seat: Pt; aisle: number; x: number; y: number
  state: 'idle' | 'working' | 'blocked'
  bubble: { text: string; until: number; bad: boolean } | null
  queue: { pts: Pt[]; done?: () => void }[]
  carrying: boolean; papers: number; look: Look; phase: number; frames: ReturnType<typeof buildFrames>
}
type Room = { id: string; name: string; index: number; ox: number; oy: number; floor: [string, string]; accent: string; door: Door; lit: number; litTo: number; open: number; openTo: number; approved: boolean }

// Recorrido en serpiente: mando, luego las etapas en orden hasta la salida al cliente.
const SLOTS: { c: number; r: number; door: Door; floor: [string, string]; accent: string }[] = [
  { c: 0, r: 0, door: 'east', floor: ['#7a5236', '#6e4930'], accent: '#f2b632' },
  { c: 1, r: 0, door: 'east', floor: ['#3d5a80', '#38537a'], accent: '#6fb1ff' },
  { c: 2, r: 0, door: 'south', floor: ['#d9cfb8', '#cdc2a8'], accent: '#e08a3c' },
  { c: 2, r: 1, door: 'west', floor: ['#3a3f4b', '#343945'], accent: '#3fc1b0' },
  { c: 1, r: 1, door: 'west', floor: ['#5b4a7a', '#544472'], accent: '#c58bff' },
  { c: 0, r: 1, door: 'west', floor: ['#9aa3a8', '#8f989d'], accent: '#d6453d' },
]
const SKINS = ['#f6d3b3', '#e8b58c', '#c98d5e', '#9a6844', '#6b4630']
const HAIRS = ['#2b1d12', '#5a3a1e', '#b5762f', '#e6c46a', '#d8d8e0', '#a13d2d', '#1d2a4a']
const INK = '#141a2b'

// Personajes como mapas de píxeles de 16 x 21. Cada letra es un color de la paleta del personaje.
const HEADS = [
  ['....oooooooo....', '...ohhhhhhhho...', '..ohhHHhhhhhho..', '..ohhhhhhhhhho..', '..ohhsssssshho..', '..ohssssssssho..', '..osssessessso..', '..osssessessso..', '..osbssssssbso..', '...osssssssso...', '....oooooooo....'],
  ['....oooooooo....', '...ohhhhhhhho...', '..ohhHHhhhhhho..', '..ohhhhhhhhhho..', '..ohhsssssshho..', '..ohssssssssho..', '..ohssessessho..', '..ohssessessho..', '..ohbssssssbho..', '..ohhsssssshho..', '..ohhoooooohho..'],
  ['...oooooooooo...', '..ohhhhhhhhhho..', '.ohhHHhhhhhhhho.', '.ohhhhhhhhhhhho.', '.ohhhsssssshhho.', '.ohhsssssssshho.', '..osssessessso..', '..osssessessso..', '..osbssssssbso..', '...osssssssso...', '....oooooooo....'],
  ['......oooo......', '.....ohHho......', '...ohhhhhhhho...', '..ohhhhhhhhhho..', '..ohhsssssshho..', '..ohssssssssho..', '..osssessessso..', '..osssessessso..', '..osbssssssbso..', '...osssssssso...', '....oooooooo....'],
]
const BODY = ['...occcccccco...', '..osccccccccso..', '..osccccccccso..', '..osCccccccCso..', '...oCCCCCCCCo...', '...oppppppppo...']
const STAND = ['...opppoopppo...', '...opppoopppo...', '...offfoofffo...', '...oooo..oooo...']
const STEP = ['...opppoopppo...', '...offfoopppo...', '...oooooofffo...', '.........oooo...']
const flip = (rows: string[]) => rows.map((r) => [...r].reverse().join(''))

function shade(hex: string, k: number) {
  const n = parseInt(hex.slice(1), 16)
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k))))
  return '#' + [n >> 16, (n >> 8) & 255, n & 255].map((v) => ch(v).toString(16).padStart(2, '0')).join('')
}

function buildFrames(look: Look, kind: Actor['kind']) {
  const pal: Record<string, string> = {
    o: '#1a1420', h: look.hair, H: shade(look.hair, 0.35), s: look.skin, b: shade(look.skin, -0.12), e: '#1b1d26',
    c: look.shirt, C: shade(look.shirt, -0.22), p: '#2f3650', f: '#11131c', g: '#e8eef7', t: '#d6453d', k: '#1b1d26', r: '#d6453d', R: '#f0736b',
  }
  let head = HEADS[look.style].map((r) => [...r])
  const body = BODY.map((r) => [...r])
  if (kind === 'auditor') { for (const x of [5, 7, 8, 10]) head[6][x] = 'g'; body[0][7] = body[0][8] = body[1][7] = body[1][8] = body[2][7] = 't' }
  if (kind === 'orch') { for (let x = 4; x < 12; x++) if (head[1][x] !== '.') head[1][x] = 'k'; head[6][2] = head[7][2] = 'k'; head[8][3] = head[8][4] = 'k' }
  if (kind === 'human') head = head.map((r, y) => (y < 3 ? r.map((ch) => (ch === 'h' ? 'r' : ch === 'H' ? 'R' : ch)) : r))
  const make = (rows: string[][]) => {
    const cv = document.createElement('canvas')
    cv.width = 16; cv.height = rows.length
    const g = cv.getContext('2d')!
    rows.forEach((row, y) => row.forEach((ch, x) => { if (pal[ch]) { g.fillStyle = pal[ch]; g.fillRect(x, y, 1, 1) } }))
    return cv
  }
  const legs = (rows: string[]) => rows.map((r) => [...r])
  const closed = head.map((r, y) => (y === 6 ? r.map((ch) => (ch === 'e' ? 's' : ch)) : r))
  return {
    idle: make([...head, ...body, ...legs(STAND)]), blink: make([...closed, ...body, ...legs(STAND)]),
    stepA: make([...head, ...body, ...legs(STEP)]), stepB: make([...head, ...body, ...legs(flip(STEP))]),
  }
}

function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

export function createWorld(scheme: SchemeT, calm = false) {
  const rooms = new Map<string, Room>()
  const actors = new Map<string, Actor>()
  let particles: { x: number; y: number; vx: number; vy: number; life: number; color: string }[] = []
  let floats: { x: number; y: number; text: string; life: number }[] = []
  let stamps: { x: number; y: number; ok: boolean; life: number }[] = []
  let flying: { x0: number; y0: number; x1: number; y1: number; t: number; dur: number; big: boolean; done?: () => void }[] = []
  let now = 0, shake = 0
  const world = { speed: 1, status: 'running' as string, actors, apply, settle, reset, update, draw, actorAt }

  function addRoom(id: string, name: string, index: number) {
    const s = SLOTS[index]
    rooms.set(id, { id, name, index, ox: s.c * RW, oy: s.r * RH, floor: s.floor, accent: s.accent, door: s.door, lit: 0, litTo: 0, open: 0, openTo: 0, approved: false })
    return rooms.get(id)!
  }
  function addActor(id: string, name: string, kind: Actor['kind'], room: Room, seat: Pt, aisle: number) {
    const h = hash(id)
    const shirt = kind === 'auditor' ? '#2a2f3d' : kind === 'orch' ? '#f2b632' : kind === 'human' ? '#efe6d0' : room.accent
    const look = { skin: SKINS[h % 5], hair: HAIRS[(h >>> 3) % 7], style: (h >>> 6) % 4, shirt }
    actors.set(id, { id, name, kind, room, seat, aisle, x: seat.x, y: seat.y, state: 'idle', bubble: null, queue: [], carrying: false, papers: 0, phase: (h % 100) / 10, look, frames: buildFrames(look, kind) })
  }
  function build() {
    rooms.clear(); actors.clear()
    const mando = addRoom('mando', 'Mando', 0)
    mando.lit = mando.litTo = mando.open = mando.openTo = 1
    addActor('orchestrator', 'Orchestrator / Executive Producer Agent', 'orch', mando, { x: 108, y: 96 }, 82)
    addActor('creative-lead', 'Creative Lead (tú)', 'human', mando, { x: 56, y: 148 }, 148)
    scheme.stages.slice(0, 5).forEach((stage, si) => {
      const room = addRoom(stage.id, stage.name, si + 1)
      const n = stage.agents.length, top = n > 4 ? Math.ceil(n / 2) : n
      stage.agents.forEach((ag, i) => {
        const row = i < top ? 0 : 1, col = row ? i - top : i, count = row ? n - top : top
        const seat = { x: room.ox + 100 - (count - 1) * 22 + col * 44, y: room.oy + (row ? 124 : 78) }
        addActor(ag.id, ag.name, 'agent', room, seat, seat.y - 14)
      })
      const ax = room.door === 'east' ? 188 : room.door === 'west' ? 28 : 150
      addActor(stage.auditor.id, stage.auditor.name, 'auditor', room, { x: room.ox + ax, y: room.oy + BOTTOM }, room.oy + BOTTOM)
    })
  }
  function reset() {
    build(); particles = []; floats = []; stamps = []; flying = []; world.status = 'running'
  }
  build()

  const doorRect = (r: Room) => r.door === 'south' ? { x: r.ox + 172, y: r.oy + RH - 3, w: 28, h: 6 } : { x: r.ox + (r.door === 'east' ? RW - 3 : -3), y: r.oy + 130, w: 6, h: 30 }
  const say = (a: Actor | undefined, text: string, bad = false) => { if (a) a.bubble = { text: text.length > 38 ? text.slice(0, 37) + '…' : text, until: now + 3.2, bad } }
  function confetti(x: number, y: number, n: number, colors: string[]) {
    if (calm) return
    for (let i = 0; i < n; i++) particles.push({ x, y, vx: (Math.random() - 0.5) * 90, vy: -30 - Math.random() * 80, life: 0.8 + Math.random() * 0.8, color: colors[i % colors.length] })
  }
  function route(a: Actor, to: Pt) {
    const lane = a.room.ox + LANE, pts: Pt[] = [{ x: a.seat.x, y: a.aisle }]
    if (to.y !== a.aisle) pts.push({ x: lane, y: a.aisle }, { x: lane, y: to.y })
    pts.push(to)
    return pts
  }
  function handoff(a: Actor, target: Actor | undefined, animate: boolean) {
    if (!target) return
    if (!animate) { target.papers++; return }
    const stand = target.kind === 'auditor' ? { x: target.seat.x + (a.room.door === 'west' ? 18 : -18), y: target.seat.y } : { x: target.seat.x + 11, y: target.aisle }
    const out = route(a, stand)
    a.carrying = true
    a.queue.push({ pts: out, done: () => { a.carrying = false; target.papers++ } })
    a.queue.push({ pts: [...out.slice(0, -1).reverse(), { ...a.seat }] })
  }

  function apply(ev: Ev, animate = true) {
    const d = ev.data ?? {}, a = actors.get(d.agent), room = rooms.get(d.stage)
    const orch = actors.get('orchestrator'), lead = actors.get('creative-lead')
    switch (ev.type) {
      case 'stage.started': if (room) { room.litTo = 1; say(orch, `Arranca ${room.name}`) } break
      case 'agent.started': if (a) { a.state = 'working'; if (d.feedback) say(a, 'Corrigiendo la entrega') } break
      case 'agent.message': say(a, d.text); break
      case 'agent.done': if (a) { a.state = 'idle'; a.papers = 0; handoff(a, actors.get(d.to), animate) } break
      case 'contract.failed': if (a) { a.state = 'blocked'; say(a, 'Entrega incompleta', true) } break
      case 'audit.started': { const aud = actors.get(d.auditor); if (aud) aud.state = 'working'; break }
      case 'audit.verdict': {
        const aud = actors.get(d.auditor)
        if (!aud) break
        aud.state = 'idle'; aud.papers = 0
        if (animate) { stamps.push({ x: aud.seat.x, y: aud.seat.y - 34, ok: d.approved, life: 1.4 }); if (!calm) shake = 0.25 }
        say(aud, d.approved ? 'Aprobado' : 'No pasa', !d.approved)
        for (const issue of d.issues ?? []) {
          const t = actors.get(issue.agent)
          if (!t) continue
          t.state = 'blocked'
          if (animate) flying.push({ x0: aud.seat.x, y0: aud.seat.y - 10, x1: t.seat.x, y1: t.seat.y - 8, t: 0, dur: 0.9, big: false, done: () => say(t, issue.problem, true) })
        }
        break
      }
      case 'stage.approved': if (room) {
        room.approved = true; room.openTo = 1
        const dr = doorRect(room), next = [...rooms.values()].find((r) => r.index === room.index + 1)
        if (animate) {
          confetti(dr.x + dr.w / 2, dr.y + dr.h / 2, 28, [room.accent, '#efe6d0', '#f2b632'])
          flying.push({ x0: dr.x, y0: dr.y + 10, x1: next ? next.ox + RW / 2 : -30, y1: next ? next.oy + 70 : dr.y, t: 0, dur: 1.3, big: true })
        }
        break
      }
      case 'gate.decided': say(lead, d.approve ? 'Aprobado, sigan' : 'Hay que repetir', !d.approve); break
      case 'cost': if (a && animate) floats.push({ x: a.seat.x, y: a.seat.y - 26, text: `-$${Number(d.usd).toFixed(2)}`, life: 1.6 }); break
      case 'project.status':
        world.status = d.status
        if (lead) lead.state = d.status === 'waiting_human' ? 'blocked' : 'idle'
        if (d.status === 'waiting_human') say(lead, d.reason === 'escalated' ? 'El auditor pide mi decisión' : 'Me toca aprobar')
        if (d.status === 'paused') say(orch, d.reason === 'budget' ? 'Tope de presupuesto' : 'En pausa', d.reason === 'budget')
        if (d.status === 'failed') say(orch, 'El motor se detuvo', true)
        if (d.status === 'done') { say(orch, 'Comercial entregado'); if (animate) for (const r of rooms.values()) confetti(r.ox + RW / 2, r.oy + 90, 26, [r.accent, '#efe6d0', '#f2b632']) }
        break
    }
  }

  /** Salta al estado final sin animaciones: se usa al cargar el historial. */
  function settle() {
    for (const a of actors.values()) { for (const q of a.queue) q.done?.(); a.queue = []; a.carrying = false; a.bubble = null; a.x = a.seat.x; a.y = a.seat.y }
    for (const r of rooms.values()) { r.lit = r.litTo; r.open = r.openTo }
    particles = []; floats = []; stamps = []; flying = []
  }

  function update(dt: number) {
    const k = dt * world.speed
    now += k
    shake = Math.max(0, shake - dt)
    for (const r of rooms.values()) { r.lit += (r.litTo - r.lit) * Math.min(1, k * 3); r.open += (r.openTo - r.open) * Math.min(1, k * 4) }
    for (const a of actors.values()) {
      if (a.bubble && a.bubble.until < now) a.bubble = null
      let left = 46 * k
      while (a.queue.length && left > 0) {
        const q = a.queue[0], p = q.pts[0]
        if (!p) { q.done?.(); a.queue.shift(); continue }
        const dx = p.x - a.x, dy = p.y - a.y, dist = Math.hypot(dx, dy)
        if (dist <= left) { a.x = p.x; a.y = p.y; q.pts.shift(); left -= dist } else { a.x += (dx / dist) * left; a.y += (dy / dist) * left; left = 0 }
      }
    }
    for (const p of particles) { p.x += p.vx * k; p.y += p.vy * k; p.vy += 160 * k; p.life -= k }
    particles = particles.filter((p) => p.life > 0)
    for (const f of floats) { f.y -= 10 * k; f.life -= k }
    floats = floats.filter((f) => f.life > 0)
    for (const s of stamps) s.life -= k
    stamps = stamps.filter((s) => s.life > 0)
    for (const f of flying) { f.t += k; if (f.t >= f.dur) f.done?.() }
    flying = flying.filter((f) => f.t < f.dur)
  }

  function actorAt(x: number, y: number) {
    let best: Actor | null = null, bestD = 16
    for (const a of actors.values()) { const dd = Math.hypot(a.x - x, a.y - 11 - y); if (dd < bestD) { bestD = dd; best = a } }
    return best
  }

  // ---------- dibujo ----------
  type C = CanvasRenderingContext2D
  const R = (c: C, color: string, x: number, y: number, w: number, h: number) => { c.fillStyle = color; c.fillRect(Math.round(x), Math.round(y), w, h) }

  function drawRoom(c: C, r: Room, t: number) {
    const { ox, oy } = r
    for (let y = 34; y < RH; y += 12) for (let x = 0; x < RW; x += r.index === 0 ? 36 : 12) R(c, r.floor[((x / 12 + y / 12) | 0) % 2], ox + x, oy + y, r.index === 0 ? 36 : 12, 12)
    R(c, '#2a3350', ox, oy, RW, 34); R(c, '#222a44', ox, oy + 26, RW, 6); R(c, r.accent, ox, oy + 32, RW, 2); R(c, 'rgba(0,0,0,.2)', ox, oy + 34, RW, 3)
    R(c, INK, ox, oy, RW, 3); R(c, INK, ox, oy, 3, RH); R(c, INK, ox + RW - 3, oy, 3, RH); R(c, INK, ox, oy + RH - 3, RW, 3)
    // rótulo
    c.font = '7px "Pixelify Sans", monospace'; c.textBaseline = 'top'
    const label = r.index ? `${r.index} ${r.name.split(' & ')[0]}` : r.name, lw = Math.ceil(c.measureText(label).width)
    R(c, INK, ox + 8, oy + 7, lw + 8, 12); R(c, r.accent, ox + 8, oy + 18, lw + 8, 1)
    c.fillStyle = r.approved ? '#7be29a' : '#efe6d0'; c.fillText(label, ox + 12, oy + 9)
    // ventana nocturna
    const wx = ox + RW - 46, wy = oy + 7
    R(c, '#efe6d0', wx - 1, wy - 1, 32, 18); R(c, '#0d1226', wx, wy, 30, 16); R(c, '#1a2550', wx, wy + 9, 30, 7)
    for (let i = 0; i < 4; i++) if (Math.sin(t * 1.5 + i * 2 + r.index) > -0.3) R(c, '#f6f1d5', wx + 4 + i * 7, wy + 2 + ((i * 5 + r.index) % 6), 1, 1)
    R(c, '#f2b632', wx + 6, wy + 11, 2, 2); R(c, '#f2b632', wx + 19, wy + 12, 2, 2); R(c, '#efe6d0', wx + 14, wy, 1, 16)
    // planta
    const px = ox + 10, py = oy + 50
    R(c, '#a8623a', px - 3, py - 5, 7, 5); R(c, '#3f9d5a', px - 4, py - 12, 9, 7); R(c, '#56c273', px - 2, py - 15, 5, 5)
    decor(c, r, t)
  }

  function decor(c: C, r: Room, t: number) {
    const { ox, oy } = r, mid = ox + 124
    if (r.index === 0) {
      // pantalla de mando: una barra por etapa
      R(c, INK, mid - 34, oy + 5, 76, 24); R(c, '#0f1a30', mid - 32, oy + 7, 72, 20)
      let i = 0
      for (const s of rooms.values()) if (s.index) { R(c, s.approved ? '#7be29a' : s.lit > 0.5 ? (Math.sin(t * 6) > 0 ? s.accent : '#33405f') : '#33405f', mid - 28 + i * 13, oy + 11, 10, 12); i++ }
      R(c, '#5d3b26', ox + 150, oy + 140, 44, 12); R(c, '#d6453d', ox + 152, oy + 132, 40, 10); R(c, '#b8352e', ox + 152, oy + 140, 40, 3)
    } else if (r.index === 1) {
      R(c, '#efe6d0', mid - 30, oy + 6, 60, 22); R(c, '#c9c0a8', mid - 30, oy + 27, 60, 1)
      ;['#f2b632', '#6fb1ff', '#d6453d', '#7be29a', '#f2b632', '#c58bff'].forEach((col, i) => R(c, col, mid - 26 + (i % 3) * 18, oy + 9 + ((i / 3) | 0) * 9, 7, 6))
    } else if (r.index === 2) {
      for (let i = 0; i < 6; i++) { R(c, '#efe6d0', mid - 34 + (i % 3) * 22, oy + 5 + ((i / 3) | 0) * 12, 18, 10); R(c, ['#e08a3c', '#3d5a80', '#5b4a7a'][i % 3], mid - 32 + (i % 3) * 22, oy + 7 + ((i / 3) | 0) * 12, 14, 6) }
    } else if (r.index === 3) {
      R(c, '#2fa66a', mid - 34, oy + 4, 64, 26); R(c, '#268a58', mid - 34, oy + 26, 64, 4)
      const cx = ox + 176, cy = oy + 62
      R(c, '#1b1d26', cx - 1, cy - 14, 2, 14); R(c, '#1b1d26', cx - 5, cy, 10, 1); R(c, '#2b2f3a', cx - 6, cy - 20, 12, 7); R(c, '#3fc1b0', cx - 8, cy - 18, 2, 3)
      if (r.lit > 0.5 && Math.sin(t * 4) > 0) R(c, '#d6453d', cx + 3, cy - 22, 2, 2)
    } else if (r.index === 4) {
      for (let i = 0; i < 3; i++) {
        R(c, INK, mid - 38 + i * 26, oy + 5, 24, 18); R(c, '#0f1a30', mid - 37 + i * 26, oy + 6, 22, 16)
        for (let j = 0; j < 4; j++) R(c, ['#c58bff', '#3fc1b0', '#f2b632', '#6fb1ff'][(i + j) % 4], mid - 36 + i * 26, oy + 8 + j * 3, r.lit > 0.5 ? 6 + ((Math.sin(t * 2 + i * 3 + j) + 1) * 7 | 0) : 8, 2)
      }
    } else {
      for (let i = 0; i < 3; i++) { R(c, '#b98a5a', ox + 172 + (i % 2) * 18, oy + 52 + ((i / 2) | 0) * -14, 16, 13); R(c, '#8a623d', ox + 172 + (i % 2) * 18, oy + 57 + ((i / 2) | 0) * -14, 16, 2) }
      R(c, '#efe6d0', mid - 22, oy + 8, 44, 16); c.fillStyle = '#d6453d'; c.fillText('Entregas', mid - 18, oy + 12)
    }
  }

  function drawDoor(c: C, r: Room) {
    if (!r.index) return
    const d = doorRect(r), closed = 1 - r.open
    R(c, r.floor[0], d.x, d.y, d.w, d.h)
    if (d.w > d.h) R(c, '#8a623d', d.x, d.y, Math.round(d.w * closed), d.h)
    else R(c, '#8a623d', d.x, d.y, d.w, Math.round(d.h * closed))
    const lx = d.w > d.h ? d.x - 5 : d.x + (r.door === 'east' ? -4 : 7), ly = d.w > d.h ? d.y - 2 : d.y - 5
    R(c, INK, lx - 1, ly - 1, 5, 5); R(c, r.approved ? '#7be29a' : '#d6453d', lx, ly, 3, 3)
  }

  function drawDesk(c: C, a: Actor, t: number) {
    const x = a.seat.x, y = a.seat.y, on = a.state === 'working' && !a.queue.length
    if (a.kind === 'auditor') {
      R(c, '#1a1420', x - 14, y - 7, 28, 14); R(c, '#6b4e39', x - 13, y - 6, 26, 2); R(c, '#5a4130', x - 13, y - 4, 26, 6); R(c, '#3d2c20', x - 13, y + 2, 26, 4)
      R(c, '#1a1420', x + 7, y - 12, 6, 7); R(c, '#f2b632', x + 8, y - 11, 4, 4); R(c, '#1a1420', x + 9, y - 7, 2, 2)
      R(c, '#1a1420', x - 12, y - 10, 7, 5); R(c, '#d6453d', x - 11, y - 9, 5, 3)
    } else if (a.kind !== 'human') {
      R(c, '#1a1420', x - 19, y - 7, 38, 16)
      R(c, '#dcb47e', x - 18, y - 6, 36, 2); R(c, '#c49a68', x - 18, y - 4, 36, 7); R(c, '#8a623d', x - 18, y + 3, 36, 5); R(c, '#75512f', x - 18, y + 6, 36, 2)
      R(c, '#1a1420', x - 7, y - 8, 14, 6); R(c, on ? '#eef2f8' : '#8d96a8', x - 6, y - 7, 12, 4); R(c, on ? (Math.sin(t * 9 + a.phase) > 0 ? a.room.accent : shade(a.room.accent, 0.4)) : '#5d6577', x - 1, y - 6, 2, 2)
      R(c, '#1a1420', x - 16, y - 4, 5, 5); R(c, '#efe6d0', x - 15, y - 3, 3, 3)
    }
    for (let i = 0; i < Math.min(a.papers, 3); i++) { R(c, '#1a1420', x + 9, y - 5 - i * 2, 8, 5); R(c, i % 2 ? '#e6dcc4' : '#ffffff', x + 10, y - 4 - i * 2, 6, 3) }
  }

  function drawActor(c: C, a: Actor, t: number, hot: boolean) {
    const walking = a.queue.length > 0, step = Math.floor(t * 8 * world.speed + a.phase) % 2
    const typing = a.state === 'working' && !walking
    const x = Math.round(a.x), bob = (walking && step) || (typing && Math.floor(t * 5 + a.phase) % 2) ? 1 : 0, y = Math.round(a.y) - (walking ? bob : -bob)
    const f = a.frames, frame = walking ? (step ? f.stepA : f.stepB) : Math.floor(t * 2 + a.phase * 7) % 17 ? f.idle : f.blink
    R(c, 'rgba(0,0,0,.28)', x - 6, Math.round(a.y) - 2, 12, 3)
    c.drawImage(frame, x - 8, y - 21)
    if (a.kind === 'auditor') { R(c, '#1a1420', x + 6, y - 11, 6, 8); R(c, '#c9a15b', x + 7, y - 10, 4, 6); R(c, '#fff', x + 8, y - 8, 2, 3) }
    if (a.carrying) { R(c, '#1a1420', x + 6, y - 13, 8, 9); R(c, '#fff', x + 7, y - 12, 6, 7); R(c, '#9aa3a8', x + 8, y - 10, 4, 1); R(c, '#9aa3a8', x + 8, y - 8, 4, 1) }
    if (a.state === 'blocked' && !a.bubble) { const b = Math.floor(t * 4) % 2; R(c, '#1a1420', x - 2, y - 33 - b, 4, 10); R(c, '#ff5a52', x - 1, y - 32 - b, 2, 5); R(c, '#ff5a52', x - 1, y - 26 - b, 2, 2) }
    if (hot) { const b = Math.floor(t * 4) % 2; R(c, '#f2b632', x - 3, y - 30 - b, 6, 2); R(c, '#f2b632', x - 2, y - 28 - b, 4, 1); R(c, '#f2b632', x - 1, y - 27 - b, 2, 1) }
  }

  function drawBubble(c: C, a: Actor) {
    const b = a.bubble!
    c.font = '7px "Pixelify Sans", monospace'; c.textBaseline = 'top'
    const w = Math.ceil(c.measureText(b.text).width) + 8
    const x = Math.max(2, Math.min(W - w - 2, Math.round(a.x - w / 2))), y = Math.max(2, Math.round(a.y) - 38)
    R(c, INK, x - 1, y - 1, w + 2, 13); R(c, b.bad ? '#ffd9d6' : '#fffaf0', x, y, w, 11); R(c, b.bad ? '#ffd9d6' : '#fffaf0', Math.round(a.x) - 1, y + 11, 3, 2)
    c.fillStyle = b.bad ? '#8f1d18' : INK; c.fillText(b.text, x + 4, y + 2)
  }

  function draw(c: C, t: number, hoverId: string | null, selectedId: string | null) {
    c.save()
    if (shake > 0) c.translate(Math.round(Math.sin(t * 90) * 2), 0)
    R(c, INK, 0, 0, W, H)
    for (const r of rooms.values()) drawRoom(c, r, t)
    for (const r of rooms.values()) drawDoor(c, r)
    const items: { y: number; f: () => void }[] = []
    for (const a of actors.values()) {
      items.push({ y: a.seat.y + 1, f: () => drawDesk(c, a, t) })
      items.push({ y: a.y, f: () => drawActor(c, a, t, a.id === selectedId) })
    }
    items.sort((p, q) => p.y - q.y).forEach((i) => i.f())
    // luz: las salas que aún no arrancan quedan a oscuras; los monitores encendidos iluminan
    for (const r of rooms.values()) if (r.lit < 0.99) R(c, `rgba(8,11,26,${(0.42 * (1 - r.lit)).toFixed(3)})`, r.ox, r.oy, RW, RH)
    c.globalCompositeOperation = 'lighter'
    for (const a of actors.values()) if (a.state === 'working' && !a.queue.length && a.kind !== 'human') {
      const g = c.createRadialGradient(a.seat.x, a.seat.y - 8, 2, a.seat.x, a.seat.y - 8, 26)
      g.addColorStop(0, a.room.accent + (Math.sin(t * 7 + a.phase) > 0 ? '40' : '30')); g.addColorStop(1, a.room.accent + '00')
      c.fillStyle = g; c.fillRect(a.seat.x - 26, a.seat.y - 34, 52, 52)
    }
    c.globalCompositeOperation = 'source-over'
    for (const f of flying) {
      const p = f.t / f.dur, x = f.x0 + (f.x1 - f.x0) * p, y = f.y0 + (f.y1 - f.y0) * p - Math.sin(Math.PI * p) * 22
      if (f.big) { R(c, INK, x - 5, y - 6, 10, 12); R(c, '#f2b632', x - 4, y - 5, 8, 10); R(c, '#fff', x - 2, y - 3, 4, 2) } else { R(c, INK, x - 4, y - 4, 7, 8); R(c, '#fff', x - 3, y - 3, 5, 6) }
    }
    for (const s of stamps) {
      const col = s.ok ? '#3ecf6e' : '#e5484d', grow = Math.min(1, (1.4 - s.life) * 8), n = Math.round(9 * grow)
      c.globalAlpha = Math.min(1, s.life * 2)
      R(c, col, s.x - n - 2, s.y - n - 2, 2 * n + 4, 2); R(c, col, s.x - n - 2, s.y + n, 2 * n + 4, 2); R(c, col, s.x - n - 2, s.y - n, 2, 2 * n); R(c, col, s.x + n, s.y - n, 2, 2 * n)
      if (s.ok) for (let i = 0; i < n; i++) { R(c, col, s.x - 5 + Math.min(i, 3), s.y + Math.min(i, 3) - 1, 2, 2); if (i > 2) R(c, col, s.x - 2 + (i - 3), s.y + 2 - (i - 3), 2, 2) }
      else for (let i = -n + 3; i < n - 2; i++) { R(c, col, s.x + i, s.y + i, 2, 2); R(c, col, s.x + i, s.y - i, 2, 2) }
      c.globalAlpha = 1
    }
    for (const p of particles) R(c, p.color, p.x, p.y, 2, 2)
    c.font = '7px "Pixelify Sans", monospace'; c.textBaseline = 'top'
    for (const f of floats) { c.globalAlpha = Math.min(1, f.life); c.fillStyle = INK; c.fillText(f.text, Math.round(f.x) - 9, Math.round(f.y) + 1); c.fillStyle = '#f2b632'; c.fillText(f.text, Math.round(f.x) - 10, Math.round(f.y)); c.globalAlpha = 1 }
    for (const a of actors.values()) if (a.bubble) drawBubble(c, a)
    const h = hoverId ? actors.get(hoverId) : null
    if (h && !h.bubble) {
      const w = Math.ceil(c.measureText(h.name).width) + 8, x = Math.max(2, Math.min(W - w - 2, Math.round(h.x - w / 2))), y = Math.max(2, Math.round(h.y) - 36)
      R(c, INK, x, y, w, 11); c.fillStyle = '#f2b632'; c.fillText(h.name, x + 4, y + 2)
    }
    c.restore()
  }

  return world
}
export type World = ReturnType<typeof createWorld>
