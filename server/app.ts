import { Hono } from 'hono'
import { extname } from 'node:path'
import type { Engine } from './engine/pipeline.ts'

const TYPES: Record<string, string> = { '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.srt': 'text/plain; charset=utf-8' }

export type AppOptions = {
  engine: Engine
  /** Lo que el navegador necesita para iniciar sesión con Supabase Auth. */
  publicConfig: { supabaseUrl: string; supabaseAnonKey: string }
  /** Valida el token de sesión y devuelve el correo si tiene acceso. */
  auth: (token: string) => Promise<string | null>
}

export function createApp({ engine, publicConfig, auth }: AppOptions) {
  const app = new Hono()
  app.onError((err, c) => c.json({ error: err.message }, 400))

  app.get('/api/config', (c) => c.json(publicConfig))

  // Todo lo demás exige sesión.
  app.use('/api/*', async (c, next) => {
    const token = c.req.header('authorization')?.replace(/^Bearer /, '')
    if (!token || !(await auth(token))) return c.json({ error: 'Inicia sesión con una cuenta autorizada' }, 401)
    await next()
  })

  app.get('/api/schemes', (c) => c.json(Object.values(engine.schemes)))
  app.get('/api/settings', async (c) => c.json(await engine.getSettings()))
  app.put('/api/settings', async (c) => c.json(await engine.setSettings(await c.req.json())))
  app.get('/api/brands', async (c) => c.json(await engine.listBrands()))

  app.get('/api/projects', async (c) => c.json(await engine.listProjects()))
  app.post('/api/projects', async (c) => {
    const body = await c.req.json()
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    const name = text(body.name), brief = text(body.brief), brandName = text(body.brandName), budgetCap = Number(body.budgetCap)
    if (!name || !brief) throw new Error('El proyecto necesita nombre y brief')
    if (!(budgetCap > 0)) throw new Error('El tope de presupuesto debe ser mayor que cero')
    const brand = brandName ? { name: brandName, kit: text(body.brandKit) } : undefined
    return c.json(await engine.createProject({ name, brief, budgetCap, brand }), 201)
  })
  app.get('/api/projects/:id', async (c) => c.json(await engine.getProject(c.req.param('id'))))

  // El navegador consulta esto cada pocos segundos: eventos nuevos y el estado del proyecto en una sola respuesta.
  app.get('/api/projects/:id/events', async (c) => {
    const id = c.req.param('id')
    const [events, project] = await Promise.all([engine.eventsAfter(id, Number(c.req.query('after')) || 0), engine.getProject(id)])
    return c.json({ events, project })
  })

  const ok = { ok: true }
  app.post('/api/projects/:id/decision', async (c) => {
    const { approve, comment, agents } = await c.req.json()
    await engine.decide(c.req.param('id'), { approve: approve === true, comment, agents })
    return c.json(ok)
  })
  app.post('/api/projects/:id/pause', async (c) => (await engine.pause(c.req.param('id')), c.json(ok)))
  app.post('/api/projects/:id/cancel', async (c) => (await engine.cancel(c.req.param('id')), c.json(ok)))
  app.post('/api/projects/:id/resume', async (c) => {
    const { budgetCap } = await c.req.json().catch(() => ({}))
    if (budgetCap !== undefined && !(Number(budgetCap) > 0)) throw new Error('El tope de presupuesto debe ser mayor que cero')
    await engine.resume(c.req.param('id'), budgetCap === undefined ? undefined : Number(budgetCap))
    return c.json(ok)
  })
  app.post('/api/projects/:id/rerun', async (c) => {
    const { agent, note } = await c.req.json()
    await engine.rerun(c.req.param('id'), String(agent), String(note ?? ''))
    return c.json(ok)
  })
  app.post('/api/projects/:id/restore', async (c) => {
    const { agent, version } = await c.req.json()
    await engine.restore(c.req.param('id'), String(agent), Number(version))
    return c.json(ok)
  })

  app.get('/api/projects/:id/files/*', async (c) => {
    const id = c.req.param('id')
    await engine.getProject(id)
    const path = decodeURIComponent(c.req.path.split('/files/')[1] ?? '')
    const content = /^[\w.-]+(\/[\w.-]+)*$/.test(path) && !path.split('/').includes('..') ? await engine.files.read(`${id}/${path}`) : null
    if (content === null) return c.json({ error: 'Archivo no encontrado' }, 404)
    return c.body(content, 200, { 'Content-Type': TYPES[extname(path)] ?? 'text/plain; charset=utf-8' })
  })

  return app
}
