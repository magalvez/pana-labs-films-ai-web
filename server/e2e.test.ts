import { PGlite } from '@electric-sql/pglite'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from './app.ts'
import { createEngine } from './engine/pipeline.ts'
import { simRunner } from './engine/simRunner.ts'
import type { Files } from './engine/types.ts'
import { simExplorer } from './explore.ts'
import { createFinance } from './finance.ts'
import { migrate, type Exec } from './migrate.ts'
import { commercial } from './schemes/commercial.ts'
import { pgDb } from './store.ts'
import { createTelegram } from './telegram.ts'
import { createUsers } from './users.ts'

// Recorrido completo por la API, como lo haría el navegador: de crear el proyecto con exploración a la entrega,
// una mejora posterior y la rentabilidad. Postgres embebido con las migraciones reales, agentes simulados con
// archivos de muestra hechos con ffmpeg de verdad, y Telegram con una red falsa. No llama a ningún proveedor.
// ponytail: el cableado de avisos copia el de server/index.ts (que no se puede importar porque arranca el servidor).

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

test('recorrido completo: exploración, cinco etapas con aprobaciones, Telegram, cliente, mejora y rentabilidad', { timeout: 120_000 }, async () => {
  const pg = new PGlite()
  await pg.exec('create schema storage; create table storage.buckets (id text primary key, name text, public boolean)')
  const exec: Exec = async (text) => (await pg.exec(text)).at(-1)?.rows ?? []
  await migrate(exec)
  const db = pgDb(async (text, params) => (await pg.query(text, params)).rows)
  const store = new Map<string, Uint8Array>()
  const inDir = (dir: string) => [...store.keys()].filter((key) => key.startsWith(dir + '/') && !key.slice(dir.length + 1).includes('/'))
  const files: Files = {
    read: async (path) => (store.has(path) ? new TextDecoder().decode(store.get(path)) : null),
    write: async (path, content) => void store.set(path, new TextEncoder().encode(content)),
    readBytes: async (path) => store.get(path) ?? null,
    writeBytes: async (path, bytes) => void store.set(path, bytes),
    list: async (dir) => inDir(dir).map((key) => key.slice(dir.length + 1)),
    copy: async (from, to) => void store.set(to, store.get(from)!),
    url: async (path) => `memoria://${path}`,
    removeDir: async (prefix) => { for (const key of inDir(prefix)) store.delete(key) },
  }

  const OWNER = 'jefa@pana.test', MEMBER = 'edita@pana.test'
  const users = createUsers({ db, owners: [OWNER], identity: { create: async () => {}, remove: async () => {} } })
  const sent: { method: string; body: any }[] = []
  const request = (async (url: string, init: any) => { sent.push({ method: String(url).split('/').pop()!, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ ok: true, result: { username: 'PanaBot' } })) }) as unknown as typeof fetch
  const texts = () => sent.filter((s) => s.method === 'sendMessage').map((s) => s.body.text as string)

  const engine = createEngine({
    db, files, schemes: { commercial }, explorer: simExplorer(),
    runner: simRunner({ rejectOnce: ['production'] }),
    onEvent: (projectId, type, data) => void notice(projectId, type, data).catch((err) => assert.fail(`aviso: ${err.message}`)),
  })
  async function stillWaiting(projectId: string, stage: string) {
    const p = await engine.getProject(projectId)
    if (p.status !== 'waiting_human' || p.currentStage !== stage) throw new Error('ese aviso ya no vale')
  }
  const telegram = createTelegram({
    db, token: 't', roleOf: (email) => users.roleOf(email), request,
    approve: async (projectId, stage) => { await stillWaiting(projectId, stage); await engine.decide(projectId, { approve: true }); return 'Aprobada.' },
    sendBack: async (projectId, stage, _e, comment) => { await stillWaiting(projectId, stage); await engine.decide(projectId, { approve: false, comment }); return 'Devuelta.' },
  })
  async function notice(projectId: string, type: string, data: Record<string, any>) {
    const status = type === 'project.status' ? data.status : null
    if (type === 'client.feedback') return telegram.notify(`cliente: ${data.text ?? ''}`)
    if (status === 'waiting_human') return telegram.notify(`espera ${(await engine.getProject(projectId)).currentStage}`, projectId, (await engine.getProject(projectId)).currentStage ?? undefined)
    if (status === 'done') return telegram.notify('entregado')
    if (status === 'failed') return telegram.notify(`falló: ${data.reason}`)
  }
  const app = createApp({ engine, users, telegram, finance: createFinance(db), publicConfig: { supabaseUrl: 'u', supabaseAnonKey: 'k' }, auth: async (t) => (t === 'admin' ? { email: OWNER, role: 'admin' } : t === 'miembro' ? { email: MEMBER, role: 'member' } : null) })

  /** Una llamada como la del navegador. Devuelve estado y cuerpo; `as` elige quién llama. */
  async function call(method: string, path: string, body?: unknown, as: 'admin' | 'miembro' | null = 'admin') {
    const headers: Record<string, string> = as ? { Authorization: `Bearer ${as}` } : {}
    const form = body instanceof FormData
    if (body !== undefined && !form) headers['Content-Type'] = 'application/json'
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : form ? body : JSON.stringify(body) })
    const type = res.headers.get('content-type') ?? ''
    return { status: res.status, headers: res.headers, json: type.includes('json') ? await res.json() : null as any, bytes: type.includes('json') ? null : new Uint8Array(await res.arrayBuffer()) }
  }
  const ok = async (method: string, path: string, body?: unknown, as: 'admin' | 'miembro' = 'admin') => {
    const r = await call(method, path, body, as)
    assert.ok(r.status < 300, `${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`)
    return r.json
  }
  /** Espera a que el proyecto deje de trabajar, como hace la pantalla consultando los eventos. */
  async function settle(id: string, want: string, stage?: string | null) {
    for (let n = 0; n < 3000; n++) {
      const { project } = await ok('GET', `/api/projects/${id}/events?after=0`)
      if (project.status === want && (stage === undefined || project.currentStage === stage)) return project
      if (['failed', 'cancelled'].includes(project.status)) assert.fail(`el proyecto quedó ${project.status}: ${project.reason}`)
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.fail(`el proyecto no llegó a ${want}${stage ? ` en ${stage}` : ''}`)
  }

  // 1. Acceso: sin sesión nada, y cada rol ve lo suyo.
  assert.equal((await call('GET', '/api/config', undefined, null)).status, 200)
  assert.equal((await call('GET', '/api/projects', undefined, null)).status, 401)
  assert.deepEqual(await ok('GET', '/api/me'), { email: OWNER, role: 'admin' })
  await ok('POST', '/api/admin/users', { email: MEMBER, role: 'member', password: 'una-clave-larga' })
  assert.equal((await call('GET', '/api/admin/projects', undefined, 'miembro')).status, 403)
  assert.equal((await call('PUT', '/api/settings', { humanReview: false }, 'miembro')).status, 403)
  assert.equal((await call('GET', '/api/admin/finance/report', undefined, 'miembro')).status, 403)

  // 2. Configuración: la pantalla lee modelos y guarda ajustes.
  const models = await ok('GET', '/api/models')
  assert.ok(models.models.length >= 3 && models.image.length >= 2 && models.video.length >= 3)
  const settings = await ok('PUT', '/api/settings', { parallelAgents: true, models: { editor: models.models[0].id } })
  assert.deepEqual([settings.humanReview, settings.simulation, settings.parallelAgents], [true, true, true])
  assert.equal((await call('PUT', '/api/settings', { videoModel: 'no-existe' })).status, 400)

  // 3. Telegram: la administradora enlaza su chat.
  const { code } = await ok('POST', '/api/telegram/link')
  await telegram.handle({ update_id: 1, message: { chat: { id: 7 }, text: `/start ${code}` } })
  assert.deepEqual(await ok('GET', '/api/telegram'), { enabled: true, linked: true })
  assert.deepEqual(await ok('GET', '/api/telegram', undefined, 'miembro'), { enabled: true, linked: false })

  // 4. Marca con logo y proyecto nuevo con fotos de referencia y exploración.
  const logo = new FormData(); logo.set('file', new File([PNG], 'x.png')); logo.set('kind', 'logo')
  assert.deepEqual(await ok('POST', '/api/brands/Aurora/assets', logo), ['logo.png'])
  const create = new FormData()
  for (const [k, v] of Object.entries({ name: 'Café Aurora 15s', brief: 'Comercial de 15 s para un café de especialidad', budgetCap: '40', brandName: 'Aurora', brandKit: 'Tono cálido', explore: 'true', referenceNote: 'Así es la taza' })) create.set(k, v)
  create.append('references', new File([PNG], 'a.png')); create.append('references', new File([PNG], 'b.png'))
  const made = await ok('POST', '/api/projects', create)
  const id: string = made.id
  assert.equal(made.status, 'exploring')
  assert.equal((await ok('GET', `/api/projects/${id}/references`)).length, 2)
  assert.equal((await call('POST', '/api/projects', { name: 'x', brief: 'y', budgetCap: 0 })).status, 400)

  // 5. Exploración: propuesta, opciones, selección, moodboard para el cliente y su opinión.
  const proposed = await ok('POST', `/api/projects/${id}/exploration/suggest`)
  const board = proposed.boards[0]
  const generated = await ok('POST', `/api/projects/${id}/exploration/boards/${board.id}/generate`, { count: 3 })
  const picked = generated.boards[0].images[0].file
  await ok('POST', `/api/projects/${id}/exploration/select`, { file: picked, selected: true })
  assert.equal((await call('POST', `/api/projects/${id}/exploration/share`, {}, 'miembro')).status, 403)
  const mood = await ok('POST', `/api/projects/${id}/exploration/share`, {})
  const seen = (await call('GET', `/api/public/${mood.token}`, undefined, null)).json
  assert.deepEqual([seen.report, seen.videos.length, seen.moodboard.boards.length > 0], ['', 0, true])
  const image = seen.moodboard.boards[0].images[0]
  const picture = await call('GET', `/api/public/${mood.token}/image/${image.name ?? image}`, undefined, null)
  assert.deepEqual([picture.status, picture.headers.get('content-type')], [200, 'image/jpeg'])
  assert.equal((await call('POST', `/api/public/${mood.token}/feedback`, { kind: 'comment', text: 'Más luz', name: 'Ana' }, null)).status, 201)
  assert.equal((await call('GET', '/api/public/m-no-existe-000000000000', undefined, null)).status, 404)
  await settle(id, 'exploring')
  assert.match(texts().at(-1)!, /cliente: Más luz/)
  await ok('POST', `/api/projects/${id}/start`)

  // 6. Strategy: llega el aviso con botones y se aprueba desde Telegram.
  await settle(id, 'waiting_human', 'strategy')
  const buttons = () => sent.filter((s) => s.body.reply_markup).at(-1)!.body.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data)
  for (let n = 0; n < 100 && buttons()[0] !== `ok:${id}:strategy`; n++) await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(buttons(), [`ok:${id}:strategy`, `no:${id}:strategy`])
  await telegram.handle({ update_id: 2, callback_query: { id: 'c', data: `ok:${id}:strategy`, message: { chat: { id: 7 } } } })
  assert.equal(texts().at(-1), 'Aprobada.')

  // 7. Pre-production: el botón viejo ya no vale; se devuelve por Telegram con una indicación y luego se aprueba con una referencia nueva.
  await settle(id, 'waiting_human', 'preproduction')
  await telegram.handle({ update_id: 3, callback_query: { id: 'c', data: `ok:${id}:strategy`, message: { chat: { id: 7 } } } })
  assert.match(texts().at(-1)!, /No se pudo aprobar: ese aviso ya no vale/)
  await telegram.handle({ update_id: 4, callback_query: { id: 'c', data: `no:${id}:preproduction`, message: { chat: { id: 7 } } } })
  await telegram.handle({ update_id: 5, message: { chat: { id: 7 }, text: 'El storyboard necesita el producto en el plano 3' } })
  assert.equal(texts().at(-1), 'Devuelta.')
  await new Promise((r) => setTimeout(r, 50))
  const again = await settle(id, 'waiting_human', 'preproduction')
  assert.ok(again.steps.some((s: any) => s.stage === 'preproduction' && s.version === 2), 'la devolución rehízo la etapa')
  const ref = new FormData(); ref.set('file', new File([PNG], 'r.png')); ref.set('note', 'El empaque real')
  const added = await ok('POST', `/api/projects/${id}/references`, ref)
  await ok('POST', `/api/projects/${id}/decision`, { approve: true, references: [added.at(-1).file] })

  // 8. Production: el auditor rechaza una vez y relanza solo al agente señalado; después pasa y se aprueba.
  const prod = await settle(id, 'waiting_human', 'production')
  assert.ok(prod.steps.some((s: any) => s.stage === 'production' && s.version === 2), 'el rechazo del auditor rehízo un agente')
  // Un miembro también puede aprobar una etapa.
  await ok('POST', `/api/projects/${id}/decision`, { approve: true }, 'miembro')

  // 9. Post-production: pausa y reanudación a mitad, luego devolución a un solo agente.
  await ok('POST', `/api/projects/${id}/pause`).catch(() => {})
  const mid = (await ok('GET', `/api/projects/${id}`)).status
  if (mid === 'paused') await ok('POST', `/api/projects/${id}/resume`, {})
  const post = await settle(id, 'waiting_human', 'postproduction')
  const one = commercial.stages.find((s) => s.id === 'postproduction')!.agents[0].id
  await ok('POST', `/api/projects/${id}/decision`, { approve: false, comment: 'Sube el volumen de la voz', agents: [one] })
  await new Promise((r) => setTimeout(r, 50))
  const post2 = await settle(id, 'waiting_human', 'postproduction')
  const v2 = post2.steps.filter((s: any) => s.stage === 'postproduction' && s.version === 2).map((s: any) => s.agent)
  assert.ok(v2.includes(one) && v2.length < post.steps.filter((s: any) => s.stage === 'postproduction').length, 'solo se rehízo lo pedido y lo que depende de ello')
  await ok('POST', `/api/projects/${id}/decision`, { approve: true })

  // 10. Delivery y entrega.
  await settle(id, 'waiting_human', 'delivery')
  await ok('POST', `/api/projects/${id}/decision`, { approve: true })
  const done = await settle(id, 'done')
  assert.equal(done.currentStage, null)
  for (let n = 0; n < 100 && texts().at(-1) !== 'entregado'; n++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(texts().at(-1), 'entregado')

  // 11. Lo que la pantalla enseña de una producción entregada: archivos, procedencia y costos.
  const assets = await ok('GET', `/api/projects/${id}/assets`)
  assert.ok(assets.some((a: any) => a.kind === 'video') && assets.some((a: any) => a.path.startsWith('exploracion/')))
  const video = assets.find((a: any) => a.kind === 'video')
  const file = await call('GET', `/api/projects/${id}/files/${video.path}`)
  assert.ok(file.status === 200 && file.bytes!.length > 1000, 'el video de muestra es un archivo real')
  assert.equal((await call('GET', `/api/projects/${id}/files/%2e%2e%2f%2e%2e%2f.env`)).status, 404, 'no se sale de la carpeta del proyecto')
  const costs = await ok('GET', `/api/admin/projects/${id}/costs`)
  assert.ok(costs && typeof costs === 'object')
  assert.ok((await ok('GET', '/api/admin/projects')).some((r: any) => r.id === id))

  // 12. Enlace para el cliente: ve la pieza, el video se sirve por tramos y su comentario llega al estudio.
  const share = await ok('POST', `/api/admin/projects/${id}/shares`, { days: 7 })
  const piece = (await call('GET', `/api/public/${share.token}`, undefined, null)).json
  assert.ok(piece.videos.length > 0, 'la vista del cliente trae al menos un video')
  const res = await app.request(`/api/public/${share.token}/video/0`, { headers: { Range: 'bytes=0-99' } })
  assert.deepEqual([res.status, res.headers.get('content-length')], [206, '100'])
  assert.equal((await call('POST', `/api/public/${share.token}/feedback`, { kind: 'comment', text: 'El final más lento', name: 'Ana' }, null)).status, 201)
  const notes = await ok('GET', `/api/projects/${id}/feedback`)
  assert.deepEqual(notes.map((n: any) => [n.text, n.status]), [['Más luz', 'new'], ['El final más lento', 'new']])
  assert.notEqual(notes[1].about, 'moodboard', 'el segundo comentario es sobre la pieza')
  await ok('POST', `/api/projects/${id}/feedback/${notes[1].id}`, { status: 'used' })
  assert.match((await ok('GET', `/api/admin/projects/${id}/report`)).markdown, /\S/)
  await ok('DELETE', `/api/admin/projects/${id}/shares/${share.token}`)
  assert.equal((await call('GET', `/api/public/${share.token}`, undefined, null)).status, 404)

  // 13. Mejora tras la entrega: pide tope, reabre desde esa etapa y hay que volver a aprobar.
  assert.equal((await call('POST', `/api/projects/${id}/improve`, { stage: 'postproduction', text: 'El final más lento, como pidió el cliente', budget: 0 })).status, 400)
  await ok('POST', `/api/projects/${id}/improve`, { stage: 'postproduction', text: 'El final más lento, como pidió el cliente', budget: 5 })
  await new Promise((r) => setTimeout(r, 50))
  await settle(id, 'waiting_human', 'postproduction')
  await ok('POST', `/api/projects/${id}/decision`, { approve: true })
  await settle(id, 'waiting_human', 'delivery')
  await ok('POST', `/api/projects/${id}/decision`, { approve: true })
  const improved = await settle(id, 'done')
  assert.equal(improved.budget_cap, 45)
  assert.ok(improved.steps.some((s: any) => s.stage === 'delivery' && s.version >= 2) && !improved.steps.some((s: any) => s.stage === 'strategy' && s.version >= 2))

  // 14. Rentabilidad: venta en dólares, gasto en pesos y el informe del mes.
  await ok('POST', `/api/admin/finance/projects/${id}/sales`, { amount: 1500, currency: 'USD', fx: 4000, date: new Date().toISOString().slice(0, 10) })
  await ok('POST', `/api/admin/finance/projects/${id}/expenses`, { description: 'Locutor', category: 'locucion', amount: 400_000, currency: 'COP', fx: 4000, date: new Date().toISOString().slice(0, 10) })
  assert.equal((await call('POST', `/api/admin/finance/projects/${id}/sales`, { amount: -1, currency: 'USD', fx: 4000, date: '2026-11-10' })).status, 400)
  const report = await ok('GET', `/api/admin/finance/report?month=${new Date().toISOString().slice(0, 7)}`)
  assert.match(JSON.stringify(report), /1500/)
  assert.match(JSON.stringify(report), /1400/, 'ganancia: 1500 de venta menos 100 del locutor (y 0 de producción simulada)')

  // 15. Plantilla, cancelación y borrado.
  const next = await ok('POST', '/api/projects', { name: 'Siguiente', brief: 'Otro', budgetCap: 20, templateId: id, explore: true })
  assert.ok((await ok('GET', `/api/projects/${next.id}/references`)).length > 0, 'la plantilla trae las referencias')
  await ok('POST', `/api/projects/${next.id}/cancel`)
  assert.equal((await call('DELETE', `/api/admin/projects/${next.id}`, { confirm: 'otro nombre' })).status, 400)
  await ok('DELETE', `/api/admin/projects/${next.id}`, { confirm: 'Siguiente' })
  assert.equal((await ok('GET', '/api/projects')).length, 1)
})
