import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { extname } from 'node:path'
import type { Engine } from './engine/pipeline.ts'
import type { Role, Users } from './users.ts'
import { CONTENT_TYPES } from './engine/tools.ts'
import { brandDir } from './engine/types.ts'
import { DEFAULT_MODEL, MODELS, RECOMMENDED } from './engine/models.ts'
import { IMAGE_MODELS, VIDEO_MODELS } from './media/prices.ts'

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
const MAX_NEW_REFERENCES = 10
/** Una foto de referencia subida por una persona: PNG o JPG, que es lo que leen los agentes y los modelos. */
async function photo(file: unknown) {
  if (!(file instanceof File)) throw new Error('Falta el archivo')
  if (file.size > MAX_BRAND_FILE) throw new Error('Cada imagen puede pesar hasta 5 MB')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const ext = imageExt(bytes)
  if (ext !== '.png' && ext !== '.jpg') throw new Error('La referencia debe ser una imagen PNG o JPG')
  return { bytes, ext, contentType: CONTENT_TYPES[ext] }
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
  /** Valida el token de sesión y devuelve quién es y su rol, si tiene acceso. */
  auth: (token: string) => Promise<{ email: string; role: Role } | null>
  /** Gestión del equipo. Sin ella (pruebas del motor) la pantalla de equipo no está disponible. */
  users?: Users
}

type Vars = { Variables: { email: string; role: Role } }

/** Sirve un archivo completo o el tramo que pide el navegador: sin esto, Safari no reproduce video. */
function ranged(c: { req: { header(name: string): string | undefined } }, bytes: Uint8Array, type: string) {
  const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' }
  const m = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '')
  if (!m || (!m[1] && !m[2])) return new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200, headers: { ...headers, 'Content-Length': String(bytes.length) } })
  const start = m[1] ? Number(m[1]) : Math.max(bytes.length - Number(m[2]), 0)
  const end = m[1] && m[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1
  if (start > end || start >= bytes.length) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes.length}` } })
  return new Response(bytes.subarray(start, end + 1) as Uint8Array<ArrayBuffer>, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(end - start + 1) } })
}

export function createApp({ engine, publicConfig, auth, users }: AppOptions) {
  const app = new Hono<Vars>()
  app.onError((err, c) => {
    console.error(`${c.req.method} ${c.req.path}: ${err.message}`)
    return c.json({ error: err.message }, 400)
  })

  app.get('/api/config', (c) => c.json(publicConfig))

  // Vista previa para clientes: sin cuenta, solo con el secreto del enlace. Enseña la pieza y su memoria, nada más.
  const gone = { error: 'Este enlace no existe o ya venció. Pide uno nuevo a tu contacto en Pana Films.' }
  app.get('/api/public/:token', async (c) => {
    const share = await engine.openShare(c.req.param('token'), true)
    if (!share) return c.json(gone, 404)
    return c.json({ name: share.name, brand: share.brand, expiresAt: share.expiresAt, report: share.report, videos: share.videos.map((v, i) => ({ index: i, label: v.label, seconds: v.seconds, width: v.width, height: v.height })) })
  })
  app.get('/api/public/:token/video/:index', async (c) => {
    const share = await engine.openShare(c.req.param('token'))
    const video = share?.videos[Number(c.req.param('index'))]
    const bytes = video ? await engine.files.readBytes(`${share!.projectId}/${video.path}`) : null
    if (!bytes) return c.json(gone, 404)
    return ranged(c, bytes, 'video/mp4')
  })

  // Todo lo demás exige sesión.
  app.use('/api/*', async (c, next) => {
    const token = c.req.header('authorization')?.replace(/^Bearer /, '')
    const who = token ? await auth(token) : null
    if (!who) return c.json({ error: 'Inicia sesión con una cuenta autorizada' }, 401)
    c.set('email', who.email)
    c.set('role', who.role)
    await next()
  })
  app.get('/api/me', (c) => c.json({ email: c.get('email'), role: c.get('role') }))

  // Administración: solo para administradores. Gestionar el equipo, borrar producciones y compartir con clientes.
  app.use('/api/admin/*', async (c, next) => {
    if (c.get('role') !== 'admin') return c.json({ error: 'Esta sección es solo para administradores' }, 403)
    await next()
  })
  app.get('/api/admin/projects', async (c) => c.json(await engine.overview()))
  app.get('/api/admin/projects/:id/costs', async (c) => c.json(await engine.costReport(c.req.param('id'))))
  app.delete('/api/admin/projects/:id', async (c) => {
    const { confirm } = await json(c)
    const p = await engine.getProject(c.req.param('id'))
    // Borrar es irreversible: quien lo pide tiene que haber escrito el nombre de la producción.
    if (confirm !== p.name) throw new Error('Escribe el nombre exacto de la producción para borrarla')
    await engine.deleteProject(p.id)
    return c.json({ ok: true })
  })
  app.get('/api/admin/projects/:id/shares', async (c) => c.json(await engine.listShares(c.req.param('id'))))
  app.post('/api/admin/projects/:id/shares', async (c) => {
    const { days } = await json(c)
    return c.json(await engine.createShare(c.req.param('id'), c.get('email'), days === undefined ? 14 : Number(days)), 201)
  })
  app.delete('/api/admin/projects/:id/shares/:token', async (c) => (await engine.revokeShare(c.req.param('id'), c.req.param('token')), c.json({ ok: true })))
  app.get('/api/admin/projects/:id/report', async (c) => c.json({ markdown: await engine.clientReport(c.req.param('id')) }))
  app.post('/api/admin/projects/:id/report', async (c) => c.json({ markdown: await engine.clientReport(c.req.param('id'), true) }))

  const team = () => { if (!users) throw new Error('La gestión del equipo no está disponible en este servidor'); return users }
  app.get('/api/admin/users', async (c) => c.json(await team().list()))
  app.post('/api/admin/users', async (c) => {
    const { email, role, password } = await json(c)
    return c.json(await team().create({ email, role, password }, c.get('email')), 201)
  })
  app.put('/api/admin/users/:email', async (c) => (await team().setRole(c.req.param('email').toLowerCase(), (await json(c)).role, c.get('email')), c.json({ ok: true })))
  app.delete('/api/admin/users/:email', async (c) => (await team().remove(c.req.param('email').toLowerCase(), c.get('email')), c.json({ ok: true })))

  app.get('/api/schemes', (c) => c.json(Object.values(engine.schemes)))
  app.get('/api/settings', async (c) => c.json(await engine.getSettings()))
  // La configuración decide cuánto se gasta: solo la cambian los administradores.
  app.put('/api/settings', async (c) => {
    if (c.get('role') !== 'admin') return c.json({ error: 'Solo un administrador puede cambiar la configuración' }, 403)
    return c.json(await engine.setSettings(await json(c)))
  })
  app.get('/api/models', (c) => c.json({ models: Object.entries(MODELS).map(([id, m]) => ({ id, name: m.name, note: m.note })), default: DEFAULT_MODEL, recommended: RECOMMENDED,
    image: Object.entries(IMAGE_MODELS).map(([id, m]) => ({ id, name: m.name, note: m.note, price: `$${m.usdPerImage.toFixed(2)} por imagen` })),
    video: Object.entries(VIDEO_MODELS).map(([id, m]) => ({ id, name: m.name, note: m.note, price: `$${m.usdPerSecond.toFixed(3)} por segundo, $${(m.usdPerSecond * 5).toFixed(2)} un clip de 5 s` })),
  }))
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
    // Un cliente puede tener varios logos (horizontal, isotipo, en negativo): el primero es `logo`, los demás `logo-N`.
    const prefix = kind === 'logo' ? 'logo' : 'producto'
    const last = Math.max(0, ...taken.map((f) => (new RegExp(`^${prefix}(-(\\d+))?\\.`).exec(f) ? Number(new RegExp(`^${prefix}-(\\d+)\\.`).exec(f)?.[1] ?? 1) : 0)))
    const filename = kind === 'logo' && !last ? `logo${ext}` : `${prefix}-${last + 1}${ext}`
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
  // Con fotos de referencia llega como formulario; sin ellas, como JSON.
  const manyBig = bodyLimit({ maxSize: MAX_NEW_REFERENCES * MAX_BRAND_FILE + 1024 * 1024, onError: (c) => c.json({ error: 'Las fotos de referencia pesan demasiado: hasta 10 imágenes de 5 MB' }, 413) })
  app.post('/api/projects', manyBig, async (c) => {
    const body: Record<string, any> = c.req.header('content-type')?.startsWith('multipart/') ? await c.req.parseBody({ all: true }) : await json(c)
    // Un selector de archivos vacío llega como un archivo sin contenido.
    const chosen = [body.references ?? []].flat().filter((f) => f instanceof File && f.size > 0)
    if (chosen.length > MAX_NEW_REFERENCES) throw new Error(`Al crear el proyecto se pueden subir hasta ${MAX_NEW_REFERENCES} fotos de referencia; el resto se añade en las aprobaciones`)
    const note = text(body.referenceNote, 500)
    const references = await Promise.all(chosen.map(async (f) => ({ ...(await photo(f)), note })))
    const name = text(body.name, 80), brief = text(body.brief, 20_000), brandName = text(body.brandName, 80), budgetCap = Number(body.budgetCap)
    if (!name || !brief) throw new Error('El proyecto necesita nombre y brief')
    if (!(budgetCap > 0 && budgetCap <= 10_000)) throw new Error('El tope de presupuesto debe estar entre 1 y 10 000 dólares')
    const brand = brandName ? { name: brandName, kit: text(body.brandKit, 20_000) } : undefined
    return c.json(await engine.createProject({ name, brief, budgetCap, brand, references }), 201)
  })
  app.get('/api/projects/:id', async (c) => c.json(await engine.getProject(c.req.param('id'))))

  // El navegador consulta esto cada pocos segundos: eventos nuevos y el estado del proyecto en una sola respuesta.
  app.get('/api/projects/:id/events', async (c) => {
    const id = c.req.param('id')
    const [events, project] = await Promise.all([engine.eventsAfter(id, Number(c.req.query('after')) || 0), engine.getProject(id)])
    return c.json({ events, project })
  })

  // Fotos de referencia que la persona adjunta al revisar una etapa. Solo PNG o JPG: es lo que leen los agentes y los modelos.
  app.get('/api/projects/:id/references', async (c) => c.json(await engine.listReferences(c.req.param('id'))))
  app.post('/api/projects/:id/references', tooBig, async (c) => {
    const { file, note } = await c.req.parseBody()
    const { bytes, ext, contentType } = await photo(file)
    return c.json(await engine.addReference(c.req.param('id'), bytes, ext, contentType, text(note, 500)), 201)
  })

  const ok = { ok: true }
  app.post('/api/projects/:id/decision', async (c) => {
    const { approve, comment, agents, references } = await json(c)
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((a) => typeof a === 'string') : undefined)
    await engine.decide(c.req.param('id'), { approve: approve === true, comment: text(comment, 5000), agents: strings(agents), references: strings(references) })
    return c.json(ok)
  })
  app.post('/api/projects/:id/pause', async (c) => (await engine.pause(c.req.param('id')), c.json(ok)))
  app.post('/api/projects/:id/cancel', async (c) => (await engine.cancel(c.req.param('id')), c.json(ok)))
  app.post('/api/projects/:id/budget', async (c) => {
    const budgetCap = Number((await json(c)).budgetCap)
    if (!(budgetCap > 0 && budgetCap <= 10_000)) throw new Error('El tope de presupuesto debe estar entre 1 y 10 000 dólares')
    return c.json(await engine.setBudget(c.req.param('id'), budgetCap))
  })
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
    return ranged(c, bytes, CONTENT_TYPES[extname(path).toLowerCase()] ?? 'text/plain; charset=utf-8')
  })

  return app
}
