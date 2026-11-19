// La oficina: estado derivado de los eventos del motor y su dibujo en pixel art.
import { HOME, NORTH, ROOM, SEATS, STAND as STAND_W, UMPIRE, createTennis, type Tennis } from './tennis'

export type Ev = { id: number; projectId: string; ts: string; type: string; data: any }
export type AgentT = { id: string; name: string; deliverables: string[] }
export type StageT = { id: string; name: string; gate: string; auditor: { id: string; name: string }; agents: AgentT[] }
export type SchemeT = { id: string; name: string; stages: StageT[] }

// Cuatro columnas: las seis salas y, a la derecha, la cafetería (216 x 352).
export const W = 864
export const H = 352
const RW = 216, RH = 176, LANE = 202, BOTTOM = 154, CAFE_X = 648

type Pt = { x: number; y: number }
type Door = 'east' | 'south' | 'west'
type Look = { skin: string; hair: string; style: number; shirt: string; cap?: string }
type Chat = { a: Actor; b: Actor; lines: string[]; i: number; next: number }
// Cabeza de cada personaje en modo libre. `rally`: 1 = quieto mirando al usuario, 2 = corriendo a su puesto.
type Mind = { wait: number; chat: Chat | null; spot: Pt | null; cup: boolean; wave: number; hop: number; rally: 0 | 1 | 2; hold: number }
export type Actor = {
  id: string; name: string; kind: 'agent' | 'auditor' | 'orch' | 'human'; room: Room
  seat: Pt; aisle: number; x: number; y: number
  state: 'idle' | 'working' | 'blocked'
  bubble: { text: string; until: number; bad: boolean; lvl?: number; dx?: number } | null
  queue: { pts: Pt[]; done?: () => void }[]
  carrying: boolean; papers: number; look: Look; phase: number; frames: ReturnType<typeof buildFrames>; mind: Mind
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
// Quienes comparten el tono de piel del Creative Lead (el de la silla de Mando).
const LEAD_SKIN = ['brand-market-research', 'character-talent-design', 'delivery', 'color', 'qc']

// Modo libre. El recorrido de salas es una línea con la cafetería (-1) entre la sala 2 y la 3.
// Las puertas están todas en la calle de su fila (y = 145 arriba, 321 abajo); cada par es [salida, entrada].
const ORDER = [0, 1, 2, -1, 3, 4, 5]
const GATES: Pt[][] = [
  [{ x: 202, y: 145 }, { x: 230, y: 145 }], [{ x: 418, y: 145 }, { x: 446, y: 145 }], [{ x: 634, y: 145 }, { x: 662, y: 145 }],
  [{ x: 662, y: 321 }, { x: 634, y: 321 }], [{ x: 446, y: 321 }, { x: 418, y: 321 }], [{ x: 230, y: 321 }, { x: 202, y: 321 }],
]
// Puestos de la cafetería (coordenadas locales). Las verticales que salen de cada uno a su calle quedan libres de muebles.
const TABLES: Pt[] = [{ x: 60, y: 108 }, { x: 156, y: 108 }, { x: 60, y: 248 }, { x: 156, y: 248 }]
const COFFEE: Pt[] = [{ x: 90, y: 62 }, { x: 108, y: 62 }, { x: 126, y: 62 }, { x: 190, y: 82 }]
const pick = <T,>(l: T[]) => l[Math.floor(Math.random() * l.length)]
const street = (row: number) => row * RH + 145

const TALKS = [
  ['¿Viste el brief del cliente?', 'Sí. Lo quiere todo para ayer.', 'Y con el logo más grande, claro.'],
  ['¿Cuántos cafés llevas hoy?', 'No lo cuentes, pero van cinco.', 'Ya eres director de arte.'],
  ['Necesito una toma más limpia.', '¿Más limpia o más barata?', 'Las dos, como siempre.'],
  ['El cliente pidió «más pop».', '¿Y qué significa «más pop»?', 'Nadie sabe. Ponle brillo.'],
  ['¿Y esa paleta de color?', 'Atardecer, pero con actitud.', 'Me gusta. Baja un poco el azul.'],
  ['¿Ensayamos el pitch?', 'Dame cinco minutos y un espresso.'],
  ['Dicen que el guion está listo.', 'Lo dijeron ayer también.', 'Y anteayer.'],
  ['Esa idea suena a premio.', 'O a reunión de tres horas.', 'Brindemos por las dos.'],
  ['Hoy toca render, ¿no?', 'Que la GPU nos acompañe.'],
  ['Quedó genial, no toques nada.', 'Solo un detallito…', '¡Nunca es un detallito!'],
  ['¿Alguien vio mi taza?', 'Está en la sala de al lado.', '¡Otra vez la perdí!'],
  ['El auditor revisa hasta las comas.', 'Por eso dormimos tranquilos.'],
  ['¿Y la locación?', 'Un set minimalista, o sea, vacío.', 'Presupuesto bajo, arte alto.'],
  ['Cliente nuevo en el radar.', '¿Pide algo raro?', 'Un perro que hable. Y barato.'],
  ['¿Terminaste la toma 12?', 'La 12 va por la versión 47.', 'Y la 47 por mi tercer café.'],
  ['Creo que el jingle pega.', 'Lo tarareé en la ducha.', 'Eso es sentencia de éxito.'],
]
const DESK = ['Esta toma ya casi sale', 'Ajustando la luz…', '¿Dónde dejé el guion?', 'Otro ajuste y listo', 'Este encuadre me gusta', 'Corte… y otra vez']
const COFFEE_SAY = ['Mmm, café recién hecho', 'Combustible creativo', 'El tercero y me detengo', 'Con espuma y todo', 'Cafecito de las buenas']
const CHEER = ['¡Vamos!', '¡Qué punto!', '¡Bravo!', '¡Esa era buena!', '¡Otra, otra!', 'Uff, casi']
const HI = ['¡Hola!', '¿Qué tal, jefe?', '¿Me buscabas?', 'Aquí, cumpliendo', '¡Buenas! ¿Una idea?']
const POKE = ['¡Pídeme lo que quieras!', 'Tengo un plan genial…', '¿Un café? Invito yo', 'Estoy en ello, jefe', '¡Luces, cámara…!', 'Shh, estoy concentrado']

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
    c: look.shirt, C: shade(look.shirt, -0.22), p: '#2f3650', f: '#11131c', g: '#e8eef7', t: '#d6453d', k: '#1b1d26', r: look.cap ?? '#d6453d', R: shade(look.cap ?? '#d6453d', 0.3),
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
  // De espaldas: la cara se cubre de pelo. Lo usa quien juega al tenis en el lado de abajo.
  const back = head.map((r) => r.map((ch) => ('seb'.includes(ch) ? 'h' : ch)))
  return {
    idle: make([...head, ...body, ...legs(STAND)]), blink: make([...closed, ...body, ...legs(STAND)]),
    stepA: make([...head, ...body, ...legs(STEP)]), stepB: make([...head, ...body, ...legs(flip(STEP))]),
    back: make([...back, ...body, ...legs(STAND)]), backA: make([...back, ...body, ...legs(STEP)]), backB: make([...back, ...body, ...legs(flip(STEP))]),
  }
}

function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

export function createWorld(scheme: SchemeT, calm = false, free = false) {
  const rooms = new Map<string, Room>()
  const actors = new Map<string, Actor>()
  let particles: { x: number; y: number; vx: number; vy: number; life: number; color: string }[] = []
  let floats: { x: number; y: number; text: string; life: number }[] = []
  let stamps: { x: number; y: number; ok: boolean; life: number }[] = []
  let flying: { x0: number; y0: number; x1: number; y1: number; t: number; dur: number; big: boolean; done?: () => void }[] = []
  let now = 0, shake = 0
  // El partido se juega en la cafetería. Al tocar la estatua, los dos jugadores y el juez caminan desde el Mando
  // (`going`), juegan (`playing`) y al terminar vuelven a pie (`leaving`). `mix` va de 0 (cafetería) a 1 (cancha).
  let match: 'off' | 'going' | 'playing' | 'leaving' = 'off', tennisOn = false, mix = 0, game: Tennis | null = null
  const STATUE = { x: 190, y: 96 }, EXIT = { x: ROOM.x + 3, y: ROOM.y + ROOM.h - 16, w: 41, h: 13 }
  const CENTER = { x: ROOM.x + ROOM.w / 2, y: ROOM.y + ROOM.h / 2 }
  const PLAYERS = ['creative-lead', 'creative-manager'], TRIO = [...PLAYERS, 'orchestrator']
  const trio = () => TRIO.flatMap((id) => actors.get(id) ?? [])
  // `lookId`: el personaje bajo el cursor. En modo libre se queda quieto y te saluda.
  let lookId: string | null = null
  const world = { speed: 1, status: 'running' as string, hot: null as string | null, actors, apply, settle, reset, update, draw, actorAt, hotspot, toggleTennis, hover, poke, rally }

  function addRoom(id: string, name: string, index: number) {
    const s = SLOTS[index]
    rooms.set(id, { id, name, index, ox: s.c * RW, oy: s.r * RH, floor: s.floor, accent: s.accent, door: s.door, lit: 0, litTo: 0, open: 0, openTo: 0, approved: false })
    return rooms.get(id)!
  }
  function addActor(id: string, name: string, kind: Actor['kind'], room: Room, seat: Pt, aisle: number, cap?: string) {
    const h = hash(id)
    const shirt = kind === 'auditor' ? '#2a2f3d' : kind === 'orch' ? '#f2b632' : kind === 'human' ? '#efe6d0' : room.accent
    const skin = SKINS[(LEAD_SKIN.includes(id) ? hash('creative-lead') : h) % 5]
    const look = { skin, hair: HAIRS[(h >>> 3) % 7], style: (h >>> 6) % 4, shirt: cap ? '#dfeaff' : shirt, cap }
    const mind: Mind = { wait: 0, chat: null, spot: null, cup: false, wave: 0, hop: 0, rally: 0, hold: 0 }
    actors.set(id, { id, name, kind, room, seat, aisle, x: seat.x, y: seat.y, state: 'idle', bubble: null, queue: [], carrying: false, papers: 0, phase: (h % 100) / 10, look, frames: buildFrames(look, kind), mind })
  }
  function build() {
    rooms.clear(); actors.clear()
    const mando = addRoom('mando', 'Mando', 0)
    mando.lit = mando.litTo = mando.open = mando.openTo = 1
    addActor('orchestrator', 'Orchestrator / Executive Producer Agent', 'orch', mando, { x: 108, y: 96 }, 82)
    addActor('creative-lead', 'Creative Lead (tú)', 'human', mando, { x: 56, y: 148 }, 148)
    addActor('creative-manager', 'Creative Manager', 'human', mando, { x: 160, y: 108 }, 108, '#3d7bd6')
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
  // Sin producción elegida todo está encendido y abierto, y cada quien arranca en su propio momento.
  if (free) {
    for (const r of rooms.values()) r.lit = r.litTo = r.open = r.openTo = 1
    for (const a of actors.values()) { a.mind.wait = 0.4 + Math.random() * 6; a.state = Math.random() < 0.6 ? 'working' : 'idle' }
  }

  const doorRect = (r: Room) => r.door === 'south' ? { x: r.ox + 172, y: r.oy + RH - 3, w: 28, h: 6 } : { x: r.ox + (r.door === 'east' ? RW - 3 : -3), y: r.oy + 130, w: 6, h: 30 }
  const say = (a: Actor | undefined, text: string, bad = false, dur = 3.2, lvl = 0) => { if (a) a.bubble = { text: text.length > 38 ? text.slice(0, 37) + '…' : text, until: now + dur, bad, lvl } }
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

  // ---------- modo libre ----------
  /** Posición en el recorrido (0 a 6) de lo que hay bajo un punto. */
  const where = (x: number, y: number) => {
    const c = x >= CAFE_X ? 3 : Math.floor(x / RW), s = SLOTS.findIndex((o) => o.c === c && o.r === (y >= RH ? 1 : 0))
    return c === 3 ? 3 : s < 3 ? s : s + 1
  }
  const atHome = (a: Actor) => Math.hypot(a.x - a.seat.x, a.y - a.seat.y) < 2
  const isTennis = (a: Actor) => match !== 'off' && TRIO.includes(a.id)
  const inStand = (p: Pt) => p.x >= ROOM.x && p.y > ROOM.y && (p.x < ROOM.x + STAND_W || p.y < ROOM.y + NORTH)
  /** Un asiento libre de la gradería, o nada si está llena. */
  const seat = () => { const open = SEATS.filter((s) => !busy(s, 6)); return open.length ? { ...pick(open) } : null }
  /** A ver el partido: se sienta un rato y, si quiere, comenta. */
  const watch = (a: Actor, to: Pt) => go(a, 3, to, () => { a.mind.wait = 8 + Math.random() * 12 })
  /** El público reacciona a lo que canta el juez: algunos saltan y uno grita. */
  function cheer(big: boolean) {
    const crowd = [...actors.values()].filter((a) => !TRIO.includes(a.id) && !a.queue.length && a.mind.spot && inStand(a.mind.spot))
    for (const a of crowd) if (big || Math.random() < 0.35) a.mind.hop = now + 0.35 + Math.random() * 0.2
    const one = crowd.length && (big || Math.random() < 0.5) ? pick(crowd) : null
    if (one && !one.bubble) say(one, pick(CHEER), false, 1.8)
  }
  const busy = (p: Pt, r = 14) => [...actors.values()].some((o) => o.mind.spot && Math.hypot(o.mind.spot.x - p.x, o.mind.spot.y - p.y) < r)
  const cafe = (p: Pt) => ({ x: CAFE_X + p.x, y: p.y })
  // Un tiempo de globo proporcional al texto; el siguiente que hable espera a que este termine.
  const span = (t: string) => 1.8 + t.length * 0.045

  /** Camina hasta el punto `pt` de la posición `to` del recorrido (pt null = su silla), cruzando las puertas por las calles. */
  function go(a: Actor, to: number, pt: Pt | null, done?: () => void) {
    const m = a.mind, from = where(a.x, a.y), pts: Pt[] = []
    m.spot = pt; m.cup = false
    // Con partido nadie pisa la arcilla: se entra por la puerta a la gradería lateral, se sube o baja por ella
    // hasta la altura del asiento y desde ahí se camina por la fila.
    const cafeStreet = (p: Pt) => (p.y >= 233 ? 321 : tennisOn ? p.y : 145)
    const lane = a.room.ox + LANE, sy = street(a.room.oy ? 1 : 0)
    if (from === 3) pts.push({ x: a.x, y: cafeStreet(a) }, { x: CAFE_X + 14, y: cafeStreet(a) })
    else if (atHome(a)) pts.push(...route(a, { x: lane, y: sy }))
    for (let p = from; p !== to;) {
      const d = to > p ? 1 : -1
      pts.push(...(d > 0 ? GATES[p] : [GATES[p - 1][1], GATES[p - 1][0]]))
      p += d
    }
    if (!pt) {
      // De vuelta a la silla: por la calle hasta el pasillo y de ahí por el mismo camino con que salió.
      pts.push({ x: lane, y: sy }, ...route(a, { x: lane, y: sy }).reverse(), { ...a.seat })
    } else if (to === 3) pts.push({ x: CAFE_X + 14, y: cafeStreet(pt) }, { x: pt.x, y: cafeStreet(pt) }, pt)
    else pts.push(pt)
    a.queue.push({ pts, done })
  }
  const roomPos = (a: Actor) => where(a.seat.x, a.seat.y)

  /** Dos personajes se citan en un punto, conversan con un guion corto y se separan. */
  function startChat(a: Actor) {
    const mine = where(a.x, a.y)
    const pool = [...actors.values()].filter((o) => o !== a && !o.mind.chat && !o.queue.length && !o.mind.rally && !isTennis(o))
    const near = pool.filter((o) => Math.abs(where(o.x, o.y) - mine) <= 2)
    const b = pick(near.length ? near : pool)
    if (!b) return false
    // En la cafetería (mostrador o mesa) o, si no, en la calle de una sala.
    let to = 3, p: Pt, q: Pt
    const tables = TABLES.map((t) => [cafe({ x: t.x - 14, y: t.y + 10 }), cafe({ x: t.x + 14, y: t.y + 10 })])
    const counter = [[cafe(COFFEE[0]), cafe(COFFEE[1])], [cafe(COFFEE[1]), cafe(COFFEE[2])]]
    // Con partido la cafetería es estadio: se conversa en las salas.
    const spots = (tennisOn ? [] : [...tables, ...counter]).filter(([u, v]) => !busy(u) && !busy(v))
    if (spots.length && Math.random() < 0.6) { const pair = pick(spots); p = pair[0]; q = pair[1] }
    else {
      to = mine === 3 ? pick([0, 1, 2, 4, 5, 6]) : mine
      // Lejos de otros corrillos para que los globos no se pisen (si en 6 intentos no hay hueco, se acepta el último).
      const ox = roomOf(to).ox, y = street(to < 3 ? 0 : 1)
      p = q = { x: 0, y }
      for (let i = 0; i < 6 && (i === 0 || busy(p, 60) || busy(q, 60)); i++) { const x = ox + 70 + Math.random() * 70; p = { x, y }; q = { x: x + 24, y } }
    }
    a.mind.chat = b.mind.chat = { a, b, lines: pick(TALKS), i: 0, next: now + 0.5 }
    go(a, to, p); go(b, to, q)
    return true
  }
  const roomOf = (pos: number) => [...rooms.values()].find((r) => r.index === (pos < 3 ? pos : pos - 1))!
  function chatTick(c: Chat) {
    if (c.a.queue.length || c.b.queue.length || now < c.next) return
    if (c.i >= c.lines.length) { c.a.mind.chat = c.b.mind.chat = null; c.a.mind.wait = 1 + Math.random() * 2; c.b.mind.wait = 1.5 + Math.random() * 2.5; return }
    const text = c.lines[c.i], dur = span(text)
    say(c.i % 2 ? c.b : c.a, text, false, dur)
    c.i++; c.next = now + dur + 0.3
  }
  /** Qué hace alguien que no tiene nada pendiente: seguir en su silla, ir por café, charlar con alguien o pasear. */
  function decide(a: Actor) {
    const m = a.mind, home = atHome(a), r = Math.random()
    a.state = 'idle'
    // Con partido, la gradería es el plan favorito.
    const place = match === 'playing' && Math.random() < 0.45 ? seat() : null
    if (place) return watch(a, place)
    if (home && r < 0.4) { a.state = Math.random() < 0.7 ? 'working' : 'idle'; m.wait = 3 + Math.random() * 6; if (Math.random() < 0.25) say(a, pick(DESK)); return }
    if (!home && r < 0.3) { go(a, roomPos(a), null, () => { a.state = 'working'; m.wait = 3 + Math.random() * 6 }); return }
    if (r < 0.72 && startChat(a)) return
    if (r < 0.85 && !home) { const to = pick([0, 1, 2, 4, 5, 6]), x = 60 + Math.random() * 110; go(a, to, { x: roomOf(to).ox + x, y: street(to < 3 ? 0 : 1) }, () => { m.wait = 1 + Math.random() * 3 }); return }
    // Café: mostrador, máquina expendedora; la taza sale solo al llegar.
    // Con partido el café está cerrado: quien iba por uno se queda a mirar, o espera en su sitio si no hay asiento.
    if (tennisOn) { const to = seat(); if (to) return watch(a, to); m.wait = 2 + Math.random() * 3; return }
    const free = COFFEE.filter((s) => !busy(cafe(s))), s = pick(free.length ? free : COFFEE)
    go(a, 3, cafe(s), () => { m.cup = true; m.wait = 4 + Math.random() * 5; if (Math.random() < 0.5) say(a, pick(COFFEE_SAY)) })
  }
  /** El cerebro de cada personaje, un paso por cuadro. */
  function think(a: Actor, k: number) {
    const m = a.mind
    if (isTennis(a)) return
    if (m.rally) {
      // Quietos y mirando de frente hasta `hold`; después corren a su silla.
      if (m.rally === 1 && now >= m.hold) { m.rally = 2; go(a, roomPos(a), null) }
      else if (m.rally === 2 && !a.queue.length) { m.rally = 0; a.state = 'working'; m.wait = 6 + Math.random() * 8 }
      return
    }
    if (m.chat) { if (m.chat.a === a) chatTick(m.chat); return }
    if (a.queue.length || a.id === lookId) return
    m.wait -= k
    if (m.wait <= 0) decide(a)
  }
  /** El cursor pasa sobre un personaje: se detiene, te mira y saluda. */
  function hover(id: string | null) {
    lookId = id
    const a = id ? actors.get(id) : null
    if (!free || !a || a.mind.rally || isTennis(a)) return
    a.mind.wave = now + 1.8
    if (!a.bubble) say(a, pick(HI), false, 2.2)
  }
  /** Un clic: se sorprende, salta y dice algo. */
  function poke(id: string) {
    const a = actors.get(id)
    if (!free || !a || a.mind.rally || isTennis(a)) return
    a.mind.wave = now + 2.4; a.mind.hop = now + 0.35
    say(a, pick(POKE), false, 2.6)
  }
  /** "Nuevo proyecto": todos se paran, miran al usuario, avisan y corren a sus puestos. */
  function rally() {
    if (!free) return
    // Cada globo sube hasta el primer piso donde no pise a los ya puestos (ni su rabo): casi todos están juntos, en la cafetería.
    const hit = (p: number[], q: number[]) => p[0] < q[2] && q[0] < p[2] && p[1] < q[3] && q[1] < p[3]
    const placed: number[][] = []
    for (const a of [...actors.values()].sort((p, q) => p.x - q.x)) {
      const m = a.mind
      if (m.chat) m.chat = null
      if (isTennis(a)) continue
      a.queue = []; a.state = 'idle'; m.cup = false; m.spot = null
      m.rally = 1; m.hold = now + 1.5; m.wave = now + 1.5
      // Prueba hasta cuatro pisos y, en cada uno, centrado o corrido a un lado; si nada cabe, se queda con el último.
      let best = { lvl: 0, dx: 0 }, body: number[] = [], stem: number[] = []
      search: for (let lvl = 0; lvl < 4; lvl++) for (const dx of [0, -44, 44]) {
        const y = a.y - 38 - lvl * 14, x = Math.max(2, Math.min(W - 96, a.x - 47 + dx))
        best = { lvl, dx }; body = [x, y, x + 94, y + 13]; stem = [a.x, y + 13, a.x + 1, a.y - 22]
        if (!placed.some((r) => hit(r, body) || hit(r, stem))) break search
      }
      placed.push(body, stem)
      say(a, '¡Listos para la acción!', false, 3.2, best.lvl)
      a.bubble!.dx = best.dx
    }
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

  /** Qué hay bajo el puntero que no es un personaje: la estatua, o el botón para volver a la oficina. */
  function hotspot(x: number, y: number) {
    if (tennisOn && x >= EXIT.x && x < EXIT.x + EXIT.w && y >= EXIT.y && y < EXIT.y + EXIT.h) return 'exit'
    return Math.abs(x - STATUE.x) < 10 && y > STATUE.y - 32 && y < STATUE.y + 3 ? 'statue' : null
  }
  /** Abre la cancha en la cafetería y manda a los tres caminando, o termina el partido y los devuelve al Mando. */
  function toggleTennis() {
    tennisOn = !tennisOn
    const orch = actors.get('orchestrator')
    // Lo que tuvieran a medias se cancela: salen desde donde estén.
    for (const a of trio()) {
      if (a.mind.chat) a.mind.chat.a.mind.chat = a.mind.chat.b.mind.chat = null
      a.queue = []; a.mind.rally = 0; a.mind.cup = false; a.bubble = null
    }
    if (tennisOn) {
      match = 'going'
      game = createTennis(HOME, {
        call: (text) => { say(actors.get('orchestrator'), text); cheer(false) },
        burst: (x, y, n) => { confetti(x, y, n, ['#f2b632', '#efe6d0', '#e9f24a']); cheer(true) },
      })
      PLAYERS.forEach((id, i) => { const a = actors.get(id); if (a) go(a, 3, { ...HOME[i] }) })
      if (orch) go(orch, 3, { ...UMPIRE })
      // Quien estaba en una mesa (o iba de camino a una) despeja la cancha y se va a la gradería; si está llena, a su puesto.
      const onCourt = (p: Pt) => p.x > ROOM.x && p.y > ROOM.y
      if (free) for (const a of actors.values()) if (!TRIO.includes(a.id) && !a.mind.rally && (onCourt(a) || (a.mind.spot && onCourt(a.mind.spot)))) {
        if (a.mind.chat) a.mind.chat.a.mind.chat = a.mind.chat.b.mind.chat = null
        a.queue = []; a.mind.cup = false; a.mind.spot = null
        const place = seat()
        if (place) watch(a, place); else go(a, roomPos(a), null, () => { a.state = 'working'; a.mind.wait = 4 + Math.random() * 6 })
      }
      say(orch, '¡A la cancha!')
    } else {
      match = 'leaving'
      for (const a of trio()) go(a, 0, null)
      // Se acabó la función: el público se levanta pronto.
      for (const a of actors.values()) if (a.mind.spot && inStand(a.mind.spot)) a.mind.wait = Math.min(a.mind.wait, 0.5 + Math.random() * 2.5)
      say(orch, 'De vuelta al trabajo')
    }
    confetti(STATUE.x, STATUE.y - 20, 30, ['#f2b632', '#ffe08a', '#c1582f'])
    if (!calm) shake = 0.3
  }
  /** Los tres siguen al partido: así sus globos y el clic caen donde están jugando. */
  function followGame() {
    if (!game) return
    PLAYERS.forEach((id, i) => { const a = actors.get(id); if (a) { a.x = game!.players[i].x; a.y = game!.players[i].y } })
    const orch = actors.get('orchestrator')
    if (orch) { orch.x = game.umpire.x; orch.y = game.umpire.y }
  }

  function update(dt: number) {
    const k = dt * world.speed
    now += k
    mix = Math.max(0, Math.min(1, mix + (tennisOn ? dt : -dt) / 0.9))
    // El partido empieza cuando los tres llegaron a su sitio; al volver, termina cuando el último se sienta.
    const walking = trio().some((a) => a.queue.length)
    if (match === 'going' && !walking) { match = 'playing'; say(actors.get('orchestrator'), '¡Juego!') }
    if (match === 'leaving' && !walking) { match = 'off'; for (const a of trio()) a.mind.wait = 2 + Math.random() * 4 }
    if (mix > 0 && game) {
      if (match === 'playing') game.update(dt)
      // Polvo de ladrillo en el borde del telón mientras se abre o se cierra.
      if (mix < 1 && !calm) for (let i = 0; i < 3; i++) {
        const a = Math.PI * 2 * Math.random(), rad = mix * mix * (3 - 2 * mix) * 200
        const x = CENTER.x + Math.cos(a) * rad, y = CENTER.y + Math.sin(a) * rad
        if (x > ROOM.x && x < ROOM.x + ROOM.w && y > ROOM.y && y < ROOM.y + ROOM.h) particles.push({ x, y, vx: (Math.random() - 0.5) * 40, vy: -20 - Math.random() * 30, life: 0.5, color: Math.random() < 0.5 ? '#e0895c' : '#c1582f' })
      }
    }
    if (mix <= 0 && !tennisOn) game = null
    shake = Math.max(0, shake - dt)
    for (const r of rooms.values()) { r.lit += (r.litTo - r.lit) * Math.min(1, k * 3); r.open += (r.openTo - r.open) * Math.min(1, k * 4) }
    for (const a of actors.values()) {
      if (a.bubble && a.bubble.until < now) a.bubble = null
      if (free) think(a, k)
      // Quien tiene el cursor encima se detiene a mirarte; quien corre a su puesto va al doble.
      // El partido no espera a la velocidad de la producción: los tres van y vuelven a paso ligero.
      const brisk = isTennis(a)
      let left = free && a.id === lookId && !brisk ? 0 : brisk ? 46 * dt * 1.9 : 46 * k * (a.mind.rally === 2 ? 2.2 : 1)
      while (a.queue.length && left > 0) {
        const q = a.queue[0], p = q.pts[0]
        if (!p) { q.done?.(); a.queue.shift(); continue }
        const dx = p.x - a.x, dy = p.y - a.y, dist = Math.hypot(dx, dy)
        if (dist <= left) { a.x = p.x; a.y = p.y; q.pts.shift(); left -= dist } else { a.x += (dx / dist) * left; a.y += (dy / dist) * left; left = 0 }
      }
    }
    if (match === 'playing') followGame()
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
    // La puerta del Mando siempre está abierta. Las que cruzan los tenistas se abren mientras van o vuelven.
    const d = doorRect(r), closed = !r.index || (r.index === 1 && (match === 'going' || match === 'leaving')) ? 0 : 1 - r.open
    R(c, r.floor[0], d.x, d.y, d.w, d.h)
    if (d.w > d.h) R(c, '#8a623d', d.x, d.y, Math.round(d.w * closed), d.h)
    else R(c, '#8a623d', d.x, d.y, d.w, Math.round(d.h * closed))
    const lx = d.w > d.h ? d.x - 5 : d.x + (r.door === 'east' ? -4 : 7), ly = d.w > d.h ? d.y - 2 : d.y - 5
    R(c, INK, lx - 1, ly - 1, 5, 5); R(c, r.approved || !r.index ? '#7be29a' : '#d6453d', lx, ly, 3, 3)
  }

  const CAFE_FLOOR = ['#c7a27a', '#bd986f'], CAFE_ACCENT = '#e86f6f'
  /** La cafetería ocupa la columna de la derecha, de arriba abajo. */
  function drawCafe(c: C, t: number) {
    const ox = CAFE_X
    for (let y = 34; y < H; y += 12) for (let x = 0; x < RW; x += 12) R(c, CAFE_FLOOR[((x / 12 + y / 12) | 0) % 2], ox + x, y, 12, 12)
    // alfombra central
    R(c, '#7a3b3b', ox + 40, 166, 136, 72); R(c, '#e8c9a0', ox + 43, 169, 130, 66); R(c, '#9a4a4a', ox + 48, 174, 120, 56)
    R(c, '#2a3350', ox, 0, RW, 34); R(c, '#222a44', ox, 26, RW, 6); R(c, CAFE_ACCENT, ox, 32, RW, 2); R(c, 'rgba(0,0,0,.2)', ox, 34, RW, 3)
    R(c, INK, ox, 0, RW, 3); R(c, INK, ox, 0, 3, H); R(c, INK, ox + RW - 3, 0, 3, H); R(c, INK, ox, H - 3, RW, 3)
    c.font = '7px "Pixelify Sans", monospace'; c.textBaseline = 'top'
    const lw = Math.ceil(c.measureText('Cafetería').width)
    R(c, INK, ox + 8, 7, lw + 8, 12); R(c, CAFE_ACCENT, ox + 8, 18, lw + 8, 1); c.fillStyle = '#efe6d0'; c.fillText('Cafetería', ox + 12, 9)
    // pizarra del menú
    R(c, INK, ox + 84, 6, 58, 22); R(c, '#25382f', ox + 86, 8, 54, 18); c.fillStyle = '#efe6d0'; c.fillText('Café 24 h', ox + 92, 11)
    R(c, '#efe6d0', ox + 92, 20, 38, 1)
    // mostrador con la cafetera y las tazas
    R(c, INK, ox + 18, 36, 116, 18); R(c, '#b98a5a', ox + 19, 37, 114, 6); R(c, '#8a623d', ox + 19, 43, 114, 10)
    R(c, INK, ox + 28, 22, 20, 17); R(c, '#9aa3a8', ox + 29, 23, 18, 14); R(c, '#d6453d', ox + 31, 25, 4, 3); R(c, INK, ox + 34, 31, 8, 6)
    if (Math.floor(t * 2) % 2) { R(c, 'rgba(255,255,255,.7)', ox + 37, 17, 1, 3); R(c, 'rgba(255,255,255,.5)', ox + 39, 14, 1, 3) }
    for (let i = 0; i < 4; i++) { R(c, '#efe6d0', ox + 62 + i * 9, 38, 5, 4); R(c, '#6b3f1d', ox + 62 + i * 9, 38, 5, 1) }
    R(c, '#e8b04a', ox + 104, 38, 12, 4)
    // máquina expendedora
    R(c, INK, ox + 184, 36, 26, 36); R(c, '#3d5a80', ox + 186, 38, 22, 32); R(c, '#0f1a30', ox + 188, 40, 14, 22)
    for (let i = 0; i < 6; i++) R(c, ['#f2b632', '#d6453d', '#7be29a', '#6fb1ff'][i % 4], ox + 190 + (i % 3) * 4, 42 + ((i / 3) | 0) * 8, 3, 5)
    R(c, '#f2b632', ox + 204, 44, 2, 2)
    // mesas con su taza
    for (const tb of TABLES) {
      R(c, 'rgba(0,0,0,.2)', ox + tb.x - 14, tb.y + 4, 30, 4)
      R(c, INK, ox + tb.x - 15, tb.y - 8, 30, 13); R(c, '#efe6d0', ox + tb.x - 14, tb.y - 7, 28, 10); R(c, '#b9ae93', ox + tb.x - 14, tb.y + 1, 28, 2)
      R(c, '#d6453d', ox + tb.x - 6, tb.y - 6, 4, 3); R(c, '#6b3f1d', ox + tb.x + 4, tb.y - 5, 4, 2)
    }
    // plantas en las esquinas de abajo
    for (const px of [18, 196]) { R(c, '#a8623a', ox + px - 4, 332, 9, 6); R(c, '#3f9d5a', ox + px - 6, 322, 13, 11); R(c, '#56c273', ox + px - 3, 317, 7, 7) }
  }
  /** Las dos puertas de la cafetería: cerradas con producción en marcha, abiertas en modo libre. Con partido se abren las dos: dan a la gradería. */
  function drawCafeDoors(c: C) {
    for (const y of [130, 306]) {
      R(c, CAFE_FLOOR[0], CAFE_X - 3, y, 6, 30)
      if (!free && match === 'off') R(c, '#8a623d', CAFE_X - 3, y, 6, 30)
    }
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
    const m = a.mind, hop = m.hop > now ? Math.round(Math.sin(((m.hop - now) / 0.35) * Math.PI) * 5) : 0
    const x = Math.round(a.x), bob = (walking && step) || (typing && Math.floor(t * 5 + a.phase) % 2) ? 1 : 0, y = Math.round(a.y) - (walking ? bob : -bob) - hop
    const f = a.frames, frame = walking ? (step ? f.stepA : f.stepB) : Math.floor(t * 2 + a.phase * 7) % 17 ? f.idle : f.blink
    R(c, 'rgba(0,0,0,.28)', x - 6, Math.round(a.y) - 2, 12, 3)
    c.drawImage(frame, x - 8, y - 21)
    if (a.kind === 'auditor') { R(c, '#1a1420', x + 6, y - 11, 6, 8); R(c, '#c9a15b', x + 7, y - 10, 4, 6); R(c, '#fff', x + 8, y - 8, 2, 3) }
    // Saluda con la mano en alto; con la taza en la otra, el café.
    if (m.wave > now) { const w = Math.floor(t * 7) % 2; R(c, INK, x + 5, y - 18 + w, 4, 6); R(c, a.look.skin, x + 6, y - 17 + w, 2, 4) }
    if (m.cup) { R(c, INK, x - 10, y - 11, 5, 5); R(c, '#efe6d0', x - 9, y - 10, 3, 3); R(c, '#6b3f1d', x - 9, y - 10, 3, 1); if (Math.floor(t * 3) % 2) R(c, '#ffffffaa', x - 8, y - 14, 1, 2) }
    if (a.carrying) { R(c, '#1a1420', x + 6, y - 13, 8, 9); R(c, '#fff', x + 7, y - 12, 6, 7); R(c, '#9aa3a8', x + 8, y - 10, 4, 1); R(c, '#9aa3a8', x + 8, y - 8, 4, 1) }
    if (a.state === 'blocked' && !a.bubble) { const b = Math.floor(t * 4) % 2; R(c, '#1a1420', x - 2, y - 33 - b, 4, 10); R(c, '#ff5a52', x - 1, y - 32 - b, 2, 5); R(c, '#ff5a52', x - 1, y - 26 - b, 2, 2) }
    if (hot) { const b = Math.floor(t * 4) % 2; R(c, '#f2b632', x - 3, y - 30 - b, 6, 2); R(c, '#f2b632', x - 2, y - 28 - b, 4, 1); R(c, '#f2b632', x - 1, y - 27 - b, 2, 1) }
  }

  function drawBubble(c: C, a: Actor) {
    const b = a.bubble!
    c.font = '7px "Pixelify Sans", monospace'; c.textBaseline = 'top'
    const w = Math.ceil(c.measureText(b.text).width) + 8
    const lift = (b.lvl ?? 0) * 14, fill = b.bad ? '#ffd9d6' : '#fffaf0'
    const x = Math.max(2, Math.min(W - w - 2, Math.round(a.x - w / 2) + (b.dx ?? 0))), y = Math.max(2, Math.round(a.y) - 38 - lift)
    R(c, INK, x - 1, y - 1, w + 2, 13); R(c, fill, x, y, w, 11)
    // Rabo: un piquito si el globo está pegado a quien habla; un hilo si se subió o se corrió para no pisar a otros.
    if (lift || b.dx) R(c, INK, Math.round(a.x), y + 12, 1, 2 + lift); else R(c, fill, Math.round(a.x) - 1, y + 11, 3, 2)
    c.fillStyle = b.bad ? '#8f1d18' : INK; c.fillText(b.text, x + 4, y + 2)
  }

  /** La cancha se descubre con un telón circular que nace en el centro de la cafetería. */
  function drawCourt(c: C, t: number) {
    if (mix <= 0 || !game) return
    const lead = actors.get(PLAYERS[0]), manager = actors.get(PLAYERS[1]), orch = actors.get('orchestrator')
    if (!lead || !manager) return
    const ease = mix * mix * (3 - 2 * mix)
    c.save()
    c.beginPath(); c.rect(ROOM.x, ROOM.y, ROOM.w, ROOM.h); c.clip()
    c.beginPath(); c.arc(CENTER.x, CENTER.y, ease * 200, 0, Math.PI * 2); c.clip()
    const f = lead.frames, m = manager.frames, playing = match === 'playing'
    game.draw(c, t, [{ idle: f.back, stepA: f.backA, stepB: f.backB }, m], () => { if (orch) c.drawImage(orch.frames.idle, Math.round(game!.umpire.x) - 8, Math.round(game!.umpire.y) - 21) }, playing)
    // Quien espera una decisión sigue avisando, aunque esté jugando.
    if (playing && lead.state === 'blocked' && !lead.bubble) { const b = Math.floor(t * 4) % 2, x = Math.round(lead.x), y = Math.round(lead.y); R(c, '#1a1420', x - 2, y - 33 - b, 4, 10); R(c, '#ff5a52', x - 1, y - 32 - b, 2, 5); R(c, '#ff5a52', x - 1, y - 26 - b, 2, 2) }
    c.restore()
    if (mix < 1) return
    // Con la cancha completa, la pared de la cafetería también cambia: rótulo, marcador (sobre la pizarra) y botón de vuelta.
    c.font = '7px "Pixelify Sans", monospace'; c.textBaseline = 'top'
    const label = 'Cancha central', lw = Math.ceil(c.measureText(label).width), wx = CAFE_X
    // La pared se repinta entera: la cafetera asomaba sobre ella.
    R(c, '#2a3350', wx + 3, 3, RW - 6, 23); R(c, '#222a44', wx + 3, 26, RW - 6, 6); R(c, '#c1582f', wx + 3, 32, RW - 6, 2)
    R(c, '#2a3350', wx + 6, 5, 76, 16); R(c, INK, wx + 8, 7, lw + 8, 12); R(c, '#c1582f', wx + 8, 18, lw + 8, 1); c.fillStyle = '#efe6d0'; c.fillText(label, wx + 12, 9)
    R(c, INK, wx + 84, 5, 76, 24); R(c, '#0f1a30', wx + 86, 7, 72, 20)
    game.board().forEach((row, i) => {
      const y = 9 + i * 9
      if (row.serving) R(c, '#e9f24a', wx + 88, y + 2, 2, 2)
      c.fillStyle = i ? '#8fb8ff' : '#ff9d96'; c.fillText(row.name, wx + 92, y)
      c.fillStyle = '#efe6d0'; c.fillText(`${row.sets} ${row.games}`, wx + 130, y)
      c.fillStyle = '#f2b632'; c.fillText(row.points, wx + 146, y)
    })
    const hot = world.hot === 'exit'
    R(c, INK, EXIT.x, EXIT.y, EXIT.w, EXIT.h); R(c, hot ? '#f2b632' : '#efe6d0', EXIT.x + 1, EXIT.y + 1, EXIT.w - 2, EXIT.h - 3); R(c, hot ? '#c08a14' : '#b9ae93', EXIT.x + 1, EXIT.y + EXIT.h - 2, EXIT.w - 2, 1)
    c.fillStyle = INK; c.fillText('A Mando', EXIT.x + 5, EXIT.y + 3)
  }

  /** El trofeo del Mando: una raqueta dorada sobre un pedestal. Al tocarlo empieza o termina el partido. */
  function drawStatue(c: C, t: number) {
    const { x, y } = STATUE, hot = world.hot === 'statue'
    const gold = hot ? '#ffd65a' : '#f2b632', dark = '#b8860b'
    R(c, 'rgba(0,0,0,.28)', x - 9, y - 1, 18, 3)
    R(c, INK, x - 8, y - 9, 16, 10); R(c, '#aeb6bb', x - 7, y - 8, 14, 3); R(c, '#7d868b', x - 7, y - 5, 14, 5); R(c, gold, x - 3, y - 4, 6, 2)
    // mango, cuello y aro con sus cuerdas
    R(c, INK, x - 2, y - 17, 4, 9); R(c, dark, x - 1, y - 16, 2, 8); R(c, gold, x - 1, y - 16, 1, 8)
    R(c, INK, x - 5, y - 31, 10, 15); R(c, gold, x - 4, y - 30, 8, 13); R(c, dark, x + 3, y - 29, 1, 11); R(c, '#fff3c4', x - 3, y - 29, 6, 11)
    for (let i = 0; i < 3; i++) { R(c, gold, x - 2 + i * 2, y - 29, 1, 11); R(c, gold, x - 3, y - 27 + i * 3, 6, 1) }
    R(c, INK, x - 5, y - 31, 1, 1); R(c, INK, x + 4, y - 31, 1, 1); R(c, INK, x - 5, y - 17, 1, 1); R(c, INK, x + 4, y - 17, 1, 1)
    // un destello recorre el trofeo cada pocos segundos
    const g = (t * 0.9) % 4
    if (g < 0.5) { const sy = y - 30 + Math.round(g * 22); R(c, '#ffffff', x - 3, sy, 2, 1); R(c, '#ffffff', x - 2, sy - 1, 1, 3) }
  }

  function draw(c: C, t: number, hoverId: string | null, selectedId: string | null) {
    c.save()
    if (shake > 0) c.translate(Math.round(Math.sin(t * 90) * 2), 0)
    R(c, INK, 0, 0, W, H)
    drawCafe(c, t)
    for (const r of rooms.values()) drawRoom(c, r, t)
    for (const r of rooms.values()) drawDoor(c, r)
    drawCafeDoors(c)
    const items: { y: number; f: () => void }[] = []
    // La cancha es piso: va debajo de todos. A los tres, mientras juegan, los dibuja el partido.
    drawCourt(c, t)
    for (const a of actors.values()) {
      items.push({ y: a.seat.y + 1, f: () => drawDesk(c, a, t) })
      if (!(match === 'playing' && TRIO.includes(a.id))) items.push({ y: a.y, f: () => drawActor(c, a, t, a.id === selectedId) })
    }
    items.sort((p, q) => p.y - q.y).forEach((i) => i.f())
    drawStatue(c, t)
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
    const tip = world.hot === 'statue' ? (tennisOn ? 'Volver a la oficina' : 'Jugar un partido') : null
    if (tip) { const w = Math.ceil(c.measureText(tip).width) + 8, x = Math.min(W - w - 2, STATUE.x - w + 12); R(c, INK, x, STATUE.y - 46, w, 11); c.fillStyle = '#f2b632'; c.fillText(tip, x + 4, STATUE.y - 44) }
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
