import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { openDb } from './db.ts'
import { claudeRunner } from './engine/claudeRunner.ts'
import { createEngine, type Engine } from './engine/pipeline.ts'
import { simRunner } from './engine/simRunner.ts'
import type { Ev } from './engine/types.ts'
import { commercial } from './schemes/commercial.ts'

const root = resolve(import.meta.dirname, '..')
mkdirSync(join(root, 'data'), { recursive: true })

const workspace = join(root, 'workspace')
const sim = simRunner({ delayMs: Number(process.env.SIM_DELAY_MS ?? 1500), rejectOnce: ['production'] })
const real = claudeRunner(workspace)
const engine: Engine = createEngine({
  db: openDb(join(root, 'data', 'lab.db')),
  workspace,
  schemes: { commercial },
  // El interruptor de simulación del panel decide, en cada paso, entre agentes enlatados y agentes reales.
  runner: {
    runAgent: (run) => (engine.getSettings().simulation ? sim : real).runAgent(run),
    runAuditor: (run) => (engine.getSettings().simulation ? sim : real).runAuditor(run),
  },
})

const TYPES: Record<string, string> = {
  '.json': 'application/json', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.srt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
}

const app = new Hono()

app.onError((err, c) => c.json({ error: err.message }, 400))

app.get('/api/schemes', (c) => c.json(Object.values(engine.schemes)))
app.get('/api/settings', (c) => c.json(engine.getSettings()))
app.put('/api/settings', async (c) => c.json(engine.setSettings(await c.req.json())))

app.get('/api/projects', (c) => c.json(engine.listProjects()))
app.post('/api/projects', async (c) => {
  const body = await c.req.json()
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const brief = typeof body.brief === 'string' ? body.brief.trim() : ''
  const budgetCap = Number(body.budgetCap)
  if (!name || !brief) throw new Error('El proyecto necesita nombre y brief')
  if (!(budgetCap > 0)) throw new Error('El tope de presupuesto debe ser mayor que cero')
  return c.json(engine.createProject({ name, brief, budgetCap }), 201)
})
app.get('/api/projects/:id', (c) => c.json(engine.getProject(c.req.param('id'))))

app.post('/api/projects/:id/decision', async (c) => {
  const { approve, comment, agents } = await c.req.json()
  void engine.decide(c.req.param('id'), { approve: approve === true, comment, agents })
  return c.json({ ok: true })
})
app.post('/api/projects/:id/pause', (c) => (engine.pause(c.req.param('id')), c.json({ ok: true })))
app.post('/api/projects/:id/cancel', (c) => (engine.cancel(c.req.param('id')), c.json({ ok: true })))
app.post('/api/projects/:id/resume', async (c) => {
  const { budgetCap } = await c.req.json().catch(() => ({}))
  if (budgetCap !== undefined && !(Number(budgetCap) > 0)) throw new Error('El tope de presupuesto debe ser mayor que cero')
  void engine.resume(c.req.param('id'), budgetCap === undefined ? undefined : Number(budgetCap))
  return c.json({ ok: true })
})
app.post('/api/projects/:id/rerun', async (c) => {
  const { agent, note } = await c.req.json()
  await engine.rerun(c.req.param('id'), String(agent), String(note ?? ''))
  return c.json({ ok: true })
})

// Historial completo y luego eventos en vivo. La oficina se reconstruye desde aquí.
app.get('/api/projects/:id/events', (c) => {
  const id = c.req.param('id')
  engine.getProject(id)
  return streamSSE(c, async (stream) => {
    let last = Number(c.req.header('Last-Event-ID') ?? c.req.query('after') ?? 0) || 0
    const queue: Ev[] = []
    let wake = () => {}
    const off = engine.subscribe((ev) => { if (ev.projectId === id) { queue.push(ev); wake() } })
    stream.onAbort(() => { off(); wake() })
    const send = async (ev: Ev) => {
      if (ev.id <= last) return
      last = ev.id
      await stream.writeSSE({ id: String(ev.id), data: JSON.stringify(ev) })
    }
    for (const ev of engine.eventsAfter(id, last)) await send(ev)
    while (!stream.aborted) {
      while (queue.length) await send(queue.shift()!)
      const timer = new Promise<void>((r) => { wake = r; setTimeout(r, 15000).unref() })
      await timer
      if (!queue.length && !stream.aborted) await stream.writeSSE({ event: 'ping', data: '' })
    }
  })
})

app.get('/api/projects/:id/files/*', (c) => {
  const id = c.req.param('id')
  engine.getProject(id)
  const base = resolve(engine.workspace, id) + sep
  const path = resolve(base, decodeURIComponent(c.req.path.split('/files/')[1] ?? ''))
  if (!path.startsWith(base) || !existsSync(path) || !statSync(path).isFile()) return c.json({ error: 'Archivo no encontrado' }, 404)
  return c.body(readFileSync(path), 200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' })
})

void engine.resumeAll()
const port = Number(process.env.PORT ?? 8787)
// Solo local. Publicarla fuera de esta máquina exige añadir contraseña primero.
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => console.log(`Pana Films Lab en http://127.0.0.1:${port}`))
