import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { extname } from 'node:path'
import type { Engine } from './engine/pipeline.ts'
import { CONTENT_TYPES } from './engine/tools.ts'
import { brandDir } from './engine/types.ts'

// Lo que el cliente puede subir a su biblioteca de marca. El SVG solo sirve como logo: los modelos no lo leen como referencia.
const MAX_BRAND_FILE = 5 * 1024 * 1024
/** El tipo se decide por el contenido del archivo, no por lo que declara quien lo sube. */
function imageExt(bytes: Uint8Array): '.png' | '.jpg' | '.svg' | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return '.png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg'
  const text = new TextDecoder().decode(bytes.subarray(0, 100_000))
  // Un SVG puede llevar código. Solo se acepta el que es dibujo y nada más.
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(text) && !/<script|<foreignObject|\son\w+\s*=|javascript:/i.test(new TextDecoder().decode(bytes))) return '.svg'
  return null
}
const safePath = (path: string) => /^[\w.-]+(\/[\w.-]+)*$/.test(path) && !path.split('/').some((part) => part === '.' || part === '..')
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
/** El cuerpo de una petición como objeto, aunque llegue vacío o mal formado. */
const json = async (c: { req: { json(): Promise<unknown> } }): Promise<Record<string, any>> => {
  const body = await c.req.json().catch(() => null)
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {}
}

export type AppOptions = {
  engine: Engine
  /** Lo que el navegador necesita para iniciar sesión con Supabase Auth. */
  publicConfig: { supabaseUrl: string; supabaseAnonKey: string }
  /** Valida el token de sesión y devuelve el correo si tiene acceso. */
  auth: (token: string) => Promise<string | null>
}

export function createApp({ engine, publicConfig, auth }: AppOptions) {
  const app = new Hono()
  app.onError((err, c) => {
    console.error(`${c.req.method} ${c.req.path}: ${err.message}`)
    return c.json({ error: err.message }, 400)
  })

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

  const brandFiles = async (name: string) => ((await engine.brandByName(name))?.assets ?? []).map((path) => path.split('/').pop()!)
  app.get('/api/brands/:name/assets', async (c) => c.json(await brandFiles(c.req.param('name'))))
  // El límite corta la subida mientras llega: no se guarda en memoria un archivo enorme para rechazarlo después.
  const tooBig = bodyLimit({ maxSize: MAX_BRAND_FILE + 64 * 1024, onError: (c) => c.json({ error: 'El archivo pesa más de 5 MB' }, 413) })
  app.post('/api/brands/:name/assets', tooBig, async (c) => {
    const name = c.req.param('name').trim().slice(0, 80)
    const { file, kind } = await c.req.parseBody()
    if (!name) throw new Error('La marca necesita un nombre')
    if (!(file instanceof File)) throw new Error('Falta el archivo')
    if (file.size > MAX_BRAND_FILE) throw new Error('El archivo pesa más de 5 MB')
    const bytes = new Uint8Array(await file.arrayBuffer())
    const ext = imageExt(bytes)
    if (!ext) throw new Error('El archivo debe ser una imagen PNG o JPG, o un logo SVG sin código')
    if (ext === '.svg' && kind !== 'logo') throw new Error('Las fotos de producto deben ser PNG o JPG')
    // El nombre lo pone el servidor: `logo` o `producto-N`. Nunca el que trae el archivo.
    const taken = await brandFiles(name)
    const last = Math.max(0, ...taken.map((f) => Number(/^producto-(\d+)\./.exec(f)?.[1] ?? 0)))
    const filename = kind === 'logo' ? `logo${ext}` : `producto-${last + 1}${ext}`
    const brand = await engine.addBrandAsset(name, filename, bytes, CONTENT_TYPES[ext])
    return c.json(brand!.assets.map((path) => path.split('/').pop()), 201)
  })
  app.get('/api/brands/:name/files/:file', async (c) => {
    const file = c.req.param('file')
    const bytes = safePath(file) ? await engine.files.readBytes(`${brandDir(c.req.param('name'))}/${file}`) : null
    if (!bytes) return c.json({ error: 'Archivo no encontrado' }, 404)
    // Un archivo subido nunca se interpreta como página: ni scripts ni adivinar el tipo.
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, { 'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Security-Policy': "sandbox; default-src 'none'", 'X-Content-Type-Options': 'nosniff' })
  })

  app.get('/api/projects', async (c) => c.json(await engine.listProjects()))
  app.post('/api/projects', async (c) => {
    const body = await json(c)
    const name = text(body.name, 80), brief = text(body.brief, 20_000), brandName = text(body.brandName, 80), budgetCap = Number(body.budgetCap)
    if (!name || !brief) throw new Error('El proyecto necesita nombre y brief')
    if (!(budgetCap > 0 && budgetCap <= 10_000)) throw new Error('El tope de presupuesto debe estar entre 1 y 10 000 dólares')
    const brand = brandName ? { name: brandName, kit: text(body.brandKit, 20_000) } : undefined
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
    const { approve, comment, agents } = await json(c)
    await engine.decide(c.req.param('id'), { approve: approve === true, comment: text(comment, 5000), agents: Array.isArray(agents) ? agents.filter((a) => typeof a === 'string') : undefined })
    return c.json(ok)
  })
  app.post('/api/projects/:id/pause', async (c) => (await engine.pause(c.req.param('id')), c.json(ok)))
  app.post('/api/projects/:id/cancel', async (c) => (await engine.cancel(c.req.param('id')), c.json(ok)))
  app.post('/api/projects/:id/resume', async (c) => {
    const { budgetCap } = await json(c)
    if (budgetCap !== undefined && !(Number(budgetCap) > 0 && Number(budgetCap) <= 10_000)) throw new Error('El tope de presupuesto debe estar entre 1 y 10 000 dólares')
    await engine.resume(c.req.param('id'), budgetCap === undefined ? undefined : Number(budgetCap))
    return c.json(ok)
  })
  app.post('/api/projects/:id/rerun', async (c) => {
    const { agent, note } = await json(c)
    await engine.rerun(c.req.param('id'), String(agent), text(note, 5000))
    return c.json(ok)
  })
  app.post('/api/projects/:id/restore', async (c) => {
    const { agent, version } = await json(c)
    if (!Number.isInteger(version) || version < 1) throw new Error('Esa versión no existe')
    await engine.restore(c.req.param('id'), String(agent), version)
    return c.json(ok)
  })

  // Procedencia de los archivos generados: herramienta, modelo, prompt, licencia, costo y medidas.
  app.get('/api/projects/:id/assets', async (c) => c.json(await engine.listAssets(c.req.param('id'))))

  app.get('/api/projects/:id/files/*', async (c) => {
    const id = c.req.param('id')
    await engine.getProject(id)
    let path = ''
    try { path = decodeURIComponent(c.req.path.slice(c.req.path.indexOf('/files/') + '/files/'.length)) } catch { /* ruta mal codificada: no existe */ }
    const bytes = safePath(path) ? await engine.files.readBytes(`${id}/${path}`) : null
    if (!bytes) return c.json({ error: 'Archivo no encontrado' }, 404)
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, { 'Content-Type': CONTENT_TYPES[extname(path).toLowerCase()] ?? 'text/plain; charset=utf-8' })
  })

  return app
}
