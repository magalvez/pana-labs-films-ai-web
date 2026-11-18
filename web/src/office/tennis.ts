// El partido del Mando: una cancha de polvo de ladrillo donde el Creative Lead y el Creative Manager juegan singles.
// Es una simulación pequeña: la pelota vuela con gravedad, bota, y cada jugador corre a donde va a caer.
// Los puntos se ganan de verdad: por un tiro que el otro no alcanza, por red o por fuera.
type C = CanvasRenderingContext2D
type Frames = { idle: CanvasImageSource; stepA: CanvasImageSource; stepB: CanvasImageSource }

// Geometría, en píxeles de la oficina. La sala del Mando ocupa de (3,34) a (213,173).
export const ROOM = { x: 3, y: 34, w: 210, h: 139 }
const L = 60, R = 156, T = 58, B = 162, NET = 110, SVC = 26, CX = 108, ALLEY = 10
const G = 90, RUN = 78, REACH_X = 9, REACH_Y = 18
const WHO = ['Lead', 'Manager'], NAMES = ['0', '15', '30', '40']
const COLORS = ['#d6453d', '#3d7bd6']

type Player = { x: number; y: number; tx: number; ty: number; wait: number; swing: number; side: number; hop: number; moving: boolean; up: boolean }
type Fate = 'in' | 'net' | 'out'

export type Hooks = {
  /** El juez de silla canta el marcador. */
  call: (text: string) => void
  /** Celebración: papelitos en un punto de la cancha. */
  burst: (x: number, y: number, n: number) => void
}

/** `from` son las posiciones de partida: los jugadores llegan corriendo desde donde estaban en la oficina. */
export function createTennis(from: { x: number; y: number }[], hooks: Hooks, rand: () => number = Math.random) {
  const home = [{ x: CX, y: 168 }, { x: CX, y: 56 }]
  // 0 juega abajo, de espaldas a quien mira. 1 juega arriba, de frente.
  const pl: Player[] = [0, 1].map((i) => ({ x: from[i].x, y: from[i].y, tx: home[i].x, ty: home[i].y, wait: 0, swing: 0, side: i ? -1 : 1, hop: 0, moving: false, up: false }))
  const ball = { x: CX, y: NET, z: 0, vx: 0, vy: 0, vz: 0, live: false }
  const score = { points: [0, 0], games: [0, 0], sets: [0, 0], server: 0, rallies: 0 }
  let phase: 'ready' | 'toss' | 'rally' | 'dead' | 'pause' = 'ready'
  let timer = 1.4, hitter = 0, rally = 0, serve = false
  let fate: Fate = 'in', bounced = false, sinceBounce = 0, winner = -1, netShake = 0
  let marks: { x: number; y: number; life: number }[] = []
  let dust: { x: number; y: number; vx: number; vy: number; life: number }[] = []
  let trail: { x: number; y: number }[] = []
  let court: HTMLCanvasElement | null = null

  const between = (a: number, b: number) => a + rand() * (b - a)
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
  // Los pies de cada jugador se quedan en su mitad, sin pisar la red ni salirse de la sala.
  const keep = (i: number, p: { x: number; y: number }) => ({ x: clamp(p.x, 40, 176), y: i ? clamp(p.y, 55, NET - 10) : clamp(p.y, NET + 14, 170) })
  const puff = (x: number, y: number, n: number) => { for (let i = 0; i < n; i++) dust.push({ x, y, vx: between(-14, 14), vy: between(-12, -2), life: between(0.25, 0.6) }) }

  /** Lado desde el que se saca: a la derecha del sacador en los puntos pares. */
  function serveDir() { return ((score.points[0] + score.points[1]) % 2 === 0 ? 1 : -1) * (score.server ? -1 : 1) }

  function startPoint() {
    phase = 'ready'; timer = 0.9; rally = 0; ball.live = false; winner = -1; trail = []
    const dir = serveDir(), s = score.server
    Object.assign(pl[s], { tx: CX + dir * 12, ty: home[s].y, wait: 0, side: s ? -1 : 1 })
    Object.assign(pl[1 - s], { tx: CX - dir * 30, ty: home[1 - s].y, wait: 0, side: s ? 1 : -1 })
  }

  /** Sale un golpe de `i` hacia `target`, que tarda `t1` segundos en botar. */
  function launch(i: number, target: { x: number; y: number }, t1: number, z0: number, f: Fate) {
    const p = pl[i]
    hitter = i; fate = f; bounced = false; sinceBounce = 0
    p.side = target.x >= p.x ? 1 : -1
    p.swing = 0.28
    Object.assign(ball, { x: p.x + p.side * 6, y: p.y, z: z0, live: true })
    ball.vx = (target.x - ball.x) / t1; ball.vy = (target.y - ball.y) / t1; ball.vz = (G * t1 * t1 / 2 - z0) / t1
    // Quien golpea vuelve al centro; quien recibe corre a donde podrá pegarle, un instante después del bote.
    p.tx = CX + between(-8, 8); p.ty = home[i].y; p.wait = 0.3
    const j = 1 - i, q = pl[j]
    const at = { x: target.x + ball.vx * 0.8 * 0.3, y: target.y + ball.vy * 0.8 * 0.3 }
    const side = at.x >= q.x ? 1 : -1
    const goal = keep(j, { x: at.x - side * 6, y: at.y })
    // Si el tiro se va a la red o afuera, el que recibe lo ve venir y afloja la carrera.
    const eager = f === 'in' ? 1 : 0.45
    q.tx = q.x + (goal.x - q.x) * eager; q.ty = q.y + (goal.y - q.y) * eager; q.wait = 0.14
  }

  function hitServe() {
    const s = score.server, dir = serveDir(), far = s ? 1 : -1
    serve = true
    const long = rand() < 0.1
    const target = { x: CX - dir * between(6, 40), y: NET + far * (long ? SVC + between(6, 11) : between(8, SVC - 4)) }
    launch(s, target, between(0.55, 0.68), 24, long ? 'out' : 'in')
  }

  function hitRally(i: number) {
    serve = false; rally++; score.rallies++
    const o = pl[1 - i], far = i ? 1 : -1
    // Casi siempre al lado que el rival dejó libre. De vez en cuando, una dejada cerca de la red.
    const open = o.x < CX ? between(CX + 10, R - 7) : between(L + 7, CX - 10)
    let x = rand() < 0.65 ? open : between(L + 7, R - 7)
    const depth = rand() < 0.08 ? between(10, 22) : between(NET - T - 34, NET - T - 6)
    let y = NET + far * depth
    const r = rand()
    const f: Fate = r < 0.06 ? 'net' : r < 0.13 ? 'out' : 'in'
    if (f === 'out') { if (rand() < 0.5) x = x > CX ? R + between(5, 9) : L - between(5, 9); else y = NET + far * (NET - T + between(5, 9)) }
    const p = pl[i]
    // El peloteo se va acelerando: tarde o temprano alguien no llega.
    const speed = 118 * (1 + 0.05 * Math.min(rally, 8)) + between(0, 20)
    launch(i, { x, y }, clamp(Math.hypot(x - p.x, y - p.y) / speed, 0.55, 1.25), 8, f)
  }

  function end(w: number, call: string | null) {
    phase = 'dead'; timer = 0.9; winner = w
    if (call) hooks.call(call)
  }

  function award() {
    // Un saque largo no da punto: se repite.
    if (winner < 0) { phase = 'pause'; timer = 0.5; return }
    const w = winner, l = 1 - w, pts = score.points
    pts[w]++; pl[w].hop = 0.5
    if (pts[w] >= 4 && pts[w] - pts[l] >= 2) {
      score.points = [0, 0]; score.games[w]++; score.server = 1 - score.server
      if (score.games[w] >= 6 && score.games[w] - score.games[l] >= 2) {
        score.games = [0, 0]; score.sets[w]++
        hooks.call(`Set para ${WHO[w]}`); hooks.burst(pl[w].x, pl[w].y - 20, 40)
      } else { hooks.call(`Juego ${WHO[w]}`); hooks.burst(pl[w].x, pl[w].y - 20, 14) }
    } else {
      const s = score.server, a = pts[s], b = pts[1 - s]
      hooks.call(a >= 3 && b >= 3 ? (a === b ? 'Iguales' : `Ventaja ${WHO[a > b ? s : 1 - s]}`) : `${NAMES[a]}-${NAMES[b]}`)
    }
    phase = 'pause'; timer = 1.1
  }

  startPoint(); timer = 1.4

  function update(dt: number) {
    for (const p of pl) {
      p.swing = Math.max(0, p.swing - dt); p.hop = Math.max(0, p.hop - dt)
      if (p.wait > 0) { p.wait -= dt; p.moving = false; continue }
      const dx = p.tx - p.x, dy = p.ty - p.y, d = Math.hypot(dx, dy), step = RUN * dt
      p.moving = d > 0.5
      if (d <= step) { p.x = p.tx; p.y = p.ty } else { p.x += (dx / d) * step; p.y += (dy / d) * step }
    }
    netShake = Math.max(0, netShake - dt)
    for (const m of marks) m.life -= dt
    marks = marks.filter((m) => m.life > 0)
    for (const d of dust) { d.x += d.vx * dt; d.y += d.vy * dt; d.life -= dt }
    dust = dust.filter((d) => d.life > 0)

    const s = pl[score.server]
    if (phase === 'ready') {
      timer -= dt
      pl[score.server].up = false
      if (timer <= 0 && !pl[0].moving && !pl[1].moving) { phase = 'toss'; timer = 0.55 }
    } else if (phase === 'toss') {
      timer -= dt
      s.up = true
      // La pelota sube desde la mano mientras la raqueta se arma arriba.
      Object.assign(ball, { x: s.x + s.side * 3, y: s.y, z: 10 + 14 * Math.sin(Math.PI * 0.5 * (1 - timer / 0.55)), live: true })
      if (timer <= 0) { s.up = false; phase = 'rally'; hitServe() }
    } else if (phase === 'pause') {
      timer -= dt
      if (timer <= 0) startPoint()
    }
    if (phase !== 'rally' && phase !== 'dead') return

    const y0 = ball.y
    ball.x += ball.vx * dt; ball.y += ball.vy * dt; ball.z += ball.vz * dt; ball.vz -= G * dt
    trail.push({ x: ball.x, y: ball.y - ball.z }); if (trail.length > 5) trail.shift()
    if (ball.z <= 0) {
      // Bote: pierde altura y velocidad, y deja su marca en la arcilla.
      ball.z = 0; ball.vz = -ball.vz * 0.62; ball.vx *= 0.8; ball.vy *= 0.8
      if (ball.vz > 6) { marks.push({ x: ball.x, y: ball.y, life: 9 }); puff(ball.x, ball.y, 4) }
      if (phase === 'rally') {
        if (bounced) end(hitter, null)
        else if (fate === 'out') end(serve ? -1 : 1 - hitter, serve ? 'Falta' : '¡Out!')
        bounced = true; sinceBounce = 0
      }
    }
    if (phase === 'dead') { timer -= dt; if (timer <= 0) award(); return }
    if (fate === 'net' && !bounced && (y0 - NET) * (ball.y - NET) <= 0) {
      ball.y = NET + (hitter ? -2 : 2); ball.vx = 0; ball.vy = 0; ball.vz = Math.min(ball.vz, -8); netShake = 0.4
      return end(1 - hitter, 'Red')
    }
    if (!bounced) return
    sinceBounce += dt
    if (sinceBounce < 0.3) return
    const j = 1 - hitter, q = pl[j]
    const side = ball.x >= q.x ? 1 : -1
    if (Math.abs(q.x + side * 6 - ball.x) < REACH_X && Math.abs(q.y - ball.y) < REACH_Y) { puff(q.x, q.y, 3); hitRally(j) }
    else if (sinceBounce > 0.42) end(hitter, null)
  }

  // ---------- dibujo ----------
  const P = (c: C, color: string, x: number, y: number, w: number, h: number) => { c.fillStyle = color; c.fillRect(Math.round(x), Math.round(y), w, h) }

  /** La cancha se pinta una vez: arcilla moteada, las huellas del rastrillo y las líneas. */
  function paintCourt() {
    const cv = document.createElement('canvas')
    cv.width = ROOM.w; cv.height = ROOM.h
    const g = cv.getContext('2d')!
    let seed = 7
    const r = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    g.fillStyle = '#c1582f'; g.fillRect(0, 0, ROOM.w, ROOM.h)
    for (let y = 0; y < ROOM.h; y += 6) { g.fillStyle = y % 12 ? 'rgba(255,220,180,.05)' : 'rgba(60,20,0,.05)'; g.fillRect(0, y, ROOM.w, 3) }
    for (let i = 0; i < 1300; i++) { g.fillStyle = r() < 0.5 ? '#cf6a3d' : '#a94a26'; g.fillRect((r() * ROOM.w) | 0, (r() * ROOM.h) | 0, 1, 1) }
    // Zonas gastadas detrás de cada línea de fondo, donde más se corre.
    for (const y of [T - 4, B + 1]) for (let i = 0; i < 60; i++) { g.fillStyle = 'rgba(232,150,105,.5)'; g.fillRect(CX - 26 + ((r() * 52) | 0) - ROOM.x, y + ((r() * 7) | 0) - ROOM.y, 2, 1) }
    const line = (x: number, y: number, w: number, h: number) => { g.fillStyle = '#f6ecdc'; g.fillRect(x - ROOM.x, y - ROOM.y, w, h) }
    line(L - ALLEY, T, R - L + 2 * ALLEY + 1, 1); line(L - ALLEY, B, R - L + 2 * ALLEY + 1, 1)
    for (const x of [L - ALLEY, L, R, R + ALLEY]) line(x, T, 1, B - T + 1)
    line(L, NET - SVC, R - L, 1); line(L, NET + SVC, R - L, 1); line(CX, NET - SVC, 1, 2 * SVC)
    line(CX, T, 1, 3); line(CX, B - 2, 1, 3)
    return cv
  }

  function drawRacket(c: C, hx: number, hy: number, x: number, y: number, color: string) {
    for (let k = 1; k < 4; k++) P(c, '#1a1420', hx + ((x - hx) * k) / 4, hy + ((y - hy) * k) / 4, 1, 1)
    P(c, color, x - 2, y - 3, 5, 6); P(c, '#fdf6d8', x - 1, y - 2, 3, 4)
  }

  function drawPlayer(c: C, i: number, f: Frames, t: number) {
    const p = pl[i], x = Math.round(p.x), lift = p.hop > 0 ? Math.round(Math.abs(Math.sin(p.hop * 12)) * 4) : 0
    const step = Math.floor(t * 9 + i) % 2, y = Math.round(p.y) - lift - (p.moving && step ? 1 : 0)
    P(c, 'rgba(0,0,0,.3)', x - 6, Math.round(p.y) - 2, 12, 3)
    c.drawImage(p.moving ? (step ? f.stepA : f.stepB) : f.idle, x - 8, y - 21)
    // La raqueta: en reposo, arriba para sacar, o barriendo hacia la pelota. El de arriba golpea hacia abajo.
    const hx = x + p.side * 6, hy = y - 9, fwd = i ? 1 : -1
    let rx = p.side * 3, ry = -6
    if (p.up) { rx = 0; ry = -13 }
    else if (p.swing > 0) {
      const u = 1 - p.swing / 0.28, a = (1 - u) * (1 - u), b = 2 * u * (1 - u), d = u * u
      rx = p.side * (8 * a + 9 * b - 2 * d); ry = fwd * (-3 * a + 8 * b + 9 * d)
    }
    drawRacket(c, hx, hy, hx + rx, hy + ry, COLORS[i])
  }

  function drawBall(c: C) {
    trail.forEach((p, k) => { c.globalAlpha = (k + 1) / 14; P(c, '#eef36a', p.x, p.y, 2, 2) })
    c.globalAlpha = 1
    P(c, 'rgba(0,0,0,.3)', ball.x, ball.y + 1, 2, 1)
    P(c, '#1a1420', ball.x - 1, ball.y - ball.z - 1, 4, 4); P(c, '#e9f24a', ball.x, ball.y - ball.z, 2, 2)
  }

  function drawNet(c: C) {
    const w = netShake > 0 ? Math.round(Math.sin(netShake * 60)) : 0
    P(c, 'rgba(0,0,0,.25)', L - ALLEY - 3, NET + 1, R - L + 2 * ALLEY + 6, 2)
    for (let x = L - ALLEY - 3; x < R + ALLEY + 3; x += 2) P(c, 'rgba(20,26,43,.6)', x, NET - 4 + w, 1, 5)
    P(c, 'rgba(20,26,43,.35)', L - ALLEY - 3, NET - 2 + w, R - L + 2 * ALLEY + 6, 1)
    P(c, '#fdf6ec', L - ALLEY - 3, NET - 5 + w, R - L + 2 * ALLEY + 6, 1); P(c, '#fdf6ec', CX, NET - 5 + w, 1, 6)
    for (const x of [L - ALLEY - 4, R + ALLEY + 3]) { P(c, '#1a1420', x, NET - 8, 2, 10); P(c, '#8d96a8', x, NET - 7, 1, 8) }
  }

  /** `frames`: las figuras de cada jugador. `umpire` dibuja al juez sobre su silla. */
  function draw(c: C, t: number, frames: [Frames, Frames], umpire: () => void) {
    court ??= paintCourt()
    c.drawImage(court, ROOM.x, ROOM.y)
    for (const m of marks) { c.globalAlpha = Math.min(1, m.life / 3) * 0.7; P(c, '#8f3d1e', m.x - 1, m.y, 3, 2) }
    c.globalAlpha = 1
    // Silla del juez, junto a la red.
    P(c, '#1a1420', 21, NET - 9, 2, 20); P(c, '#1a1420', 34, NET - 9, 2, 20); P(c, '#1a1420', 21, NET + 2, 15, 1); P(c, '#3f9d5a', 20, NET - 10, 17, 3)
    umpire()
    const things: { y: number; f: () => void }[] = [
      { y: NET, f: () => drawNet(c) },
      { y: pl[0].y, f: () => drawPlayer(c, 0, frames[0], t) },
      { y: pl[1].y, f: () => drawPlayer(c, 1, frames[1], t) },
    ]
    if (ball.live) things.push({ y: ball.y + 0.5, f: () => drawBall(c) })
    things.sort((a, b) => a.y - b.y).forEach((i) => i.f())
    for (const d of dust) { c.globalAlpha = Math.min(1, d.life * 2.5); P(c, '#eab08a', d.x, d.y, 2, 2) }
    c.globalAlpha = 1
    // Focos: dos conos de luz cálida desde las esquinas de arriba.
    c.globalCompositeOperation = 'lighter'
    for (const x of [ROOM.x + 12, ROOM.x + ROOM.w - 12]) {
      const g = c.createRadialGradient(x, ROOM.y, 4, x, ROOM.y, 130)
      g.addColorStop(0, `rgba(255,240,190,${(0.2 + Math.sin(t * 3 + x) * 0.015).toFixed(3)})`); g.addColorStop(1, 'rgba(255,240,190,0)')
      c.fillStyle = g; c.fillRect(ROOM.x, ROOM.y, ROOM.w, ROOM.h)
    }
    c.globalCompositeOperation = 'source-over'
  }

  /** Lo que muestra el marcador de pared: juegos y puntos de cada uno, y quién saca. */
  function board() {
    const [a, b] = score.points, deuce = a >= 3 && b >= 3
    const pts = (mine: number, other: number) => (deuce ? (mine > other ? 'AD' : '40') : NAMES[mine])
    return [0, 1].map((i) => ({ name: WHO[i], sets: score.sets[i], games: score.games[i], points: pts(score.points[i], score.points[1 - i]), serving: score.server === i }))
  }

  return { update, draw, board, score, players: pl, umpire: { x: 28, y: NET - 7 } }
}
export type Tennis = ReturnType<typeof createTennis>
