import { PGlite } from '@electric-sql/pglite'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { migrate, migrationStatus, type Exec } from '../migrate.ts'
import { commercial } from '../schemes/commercial.ts'
import { pgDb } from '../store.ts'
import { createEngine } from './pipeline.ts'
import { simRunner as realSimRunner } from './simRunner.ts'
import { createApp } from '../app.ts'
import { brandDir, type Db, type Files, type Runner } from './types.ts'

const AGENTS = commercial.stages.flatMap((s) => s.agents).length
const root = join(import.meta.dirname, '..', '..')

// El motor se prueba sobre Postgres embebido con las migraciones reales, y con los archivos en memoria.
async function makePg() {
  const pg = new PGlite()
  // PGlite no trae el esquema `storage` de Supabase; basta con la tabla que toca la migración del bucket.
  await pg.exec('create schema storage; create table storage.buckets (id text primary key, name text, public boolean)')
  const exec: Exec = async (text) => (await pg.exec(text)).at(-1)?.rows ?? []
  return { pg, exec }
}
async function makeDb(): Promise<Db> {
  const { pg, exec } = await makePg()
  await migrate(exec)
  return pgDb(async (text, params) => (await pg.query(text, params)).rows)
}
function memoryFiles(): Files {
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
  return files
}
// En las pruebas del motor los archivos de muestra son tres bytes: ffmpeg se prueba aparte, en server/media.
const MEDIA = new Uint8Array([1, 2, 3])
const simRunner = (o: Parameters<typeof realSimRunner>[0] = {}) => realSimRunner({ media: async () => MEDIA, ...o })
async function setup(runner: Runner = simRunner(), shared?: { db: Db; files: Files }) {
  const db = shared?.db ?? (await makeDb())
  const files = shared?.files ?? memoryFiles()
  return { engine: createEngine({ db, files, schemes: { commercial }, runner }), db, files }
}
async function start(engine: Awaited<ReturnType<typeof setup>>['engine'], budgetCap = 100) {
  const { id } = await engine.createProject({ name: 'Prueba', brief: 'Comercial de 15 s', budgetCap })
  await engine.advance(id)
  return id
}

test('sin revisión humana, un proyecto recorre las 5 etapas', async () => {
  const { engine } = await setup()
  await engine.setSettings({ humanReview: false })
  const p = await engine.getProject(await start(engine))
  assert.equal(p.status, 'done')
  assert.equal(p.steps.length, AGENTS)
  assert.deepEqual(p.stages.map((s) => s.status), Array(5).fill('approved'))
  assert.equal(p.steps[0].model, 'simulación')
})

test('un rechazo del auditor relanza solo al agente señalado', async () => {
  const { engine } = await setup(simRunner({ rejectOnce: ['production'] }))
  await engine.setSettings({ humanReview: false })
  const p = await engine.getProject(await start(engine))
  assert.equal(p.status, 'done')
  assert.deepEqual(p.steps.filter((s) => s.version > 1).map((s) => `${s.agent} v${s.version}`), ['cinematography v2'])
  assert.equal(p.steps.find((s) => s.agent === 'cinematography' && s.version === 1)?.status, 'rejected')
})

test('con revisión humana el gate pausa; aprobar avanza y rechazar devuelve el trabajo', async () => {
  const { engine } = await setup()
  const id = await start(engine)
  let p = await engine.getProject(id)
  assert.deepEqual([p.status, p.reason, p.currentStage], ['waiting_human', 'gate', 'strategy'])

  await engine.decide(id, { approve: true })
  await engine.advance(id)
  assert.equal((await engine.getProject(id)).currentStage, 'preproduction')

  await assert.rejects(engine.decide(id, { approve: false }), /comentario/)
  await engine.decide(id, { approve: false, comment: 'El storyboard no cierra con el producto', agents: ['storyboard-previs'] })
  await engine.advance(id)
  p = await engine.getProject(id)
  assert.deepEqual([p.status, p.currentStage], ['waiting_human', 'preproduction'])
  assert.deepEqual(p.steps.filter((s) => s.version === 2).map((s) => s.agent), ['storyboard-previs'])
})

test('el tope de presupuesto detiene el motor y subirlo lo reanuda', async () => {
  const paid: Runner = { ...simRunner(), runAgent: async (run) => ({ ...(await simRunner().runAgent(run)), costUsd: 1 }) }
  const { engine } = await setup(paid)
  await engine.setSettings({ humanReview: false })
  const id = await start(engine, 2.5)
  let p = await engine.getProject(id)
  assert.deepEqual([p.status, p.reason, p.steps.length, p.spent], ['paused', 'budget', 3, 3])
  await engine.resume(id, 1000)
  await engine.advance(id)
  p = await engine.getProject(id)
  assert.deepEqual([p.status, p.spent], ['done', AGENTS])
})

test('tras reiniciar, el proyecto sigue desde el último paso completo', async () => {
  let calls = 0
  let crashed!: () => void
  const reached = new Promise<void>((r) => (crashed = r))
  const dying: Runner = { ...simRunner(), runAgent: (run) => (++calls === 6 ? (crashed(), new Promise(() => {})) : simRunner().runAgent(run)) }
  const first = await setup(dying)
  await first.engine.setSettings({ humanReview: false })
  const { id } = await first.engine.createProject({ name: 'Caída', brief: 'x', budgetCap: 100 })
  await reached

  let resumed = 0
  const counting: Runner = { ...simRunner(), runAgent: (run) => (resumed++, simRunner().runAgent(run)) }
  const second = (await setup(counting, first)).engine
  await second.resumeAll()
  assert.equal((await second.getProject(id)).status, 'done')
  assert.equal(resumed, AGENTS - 5)
})

test('un traspaso incompleto se relanza sin llegar al auditor', async () => {
  let first = true
  const sloppy: Runner = { ...simRunner(), runAgent: async (run) => (first ? ((first = false), { costUsd: 0, model: 'x' }) : simRunner().runAgent(run)) }
  const { engine } = await setup(sloppy)
  await engine.setSettings({ humanReview: false })
  const id = await start(engine)
  assert.equal((await engine.getProject(id)).status, 'done')
  const types = (await engine.eventsAfter(id)).map((e) => e.type)
  assert.equal(types.filter((t) => t === 'contract.failed').length, 1)
  assert.ok(types.indexOf('contract.failed') < types.indexOf('audit.started'))
})

test('tras 2 reintentos el auditor escala a una persona aunque la revisión humana esté apagada', async () => {
  const strict: Runner = { ...simRunner(), runAuditor: async ({ stage }) => ({ approved: false, costUsd: 0, issues: [{ agent: stage.agents[0].id, problem: 'No cumple' }] }) }
  const { engine } = await setup(strict)
  await engine.setSettings({ humanReview: false })
  const p = await engine.getProject(await start(engine))
  assert.deepEqual([p.status, p.reason, p.currentStage], ['waiting_human', 'escalated', 'strategy'])
  assert.equal(p.steps.filter((s) => s.agent === 'brief-strategy').length, 3)
})

test('volver a una versión anterior la copia como versión nueva y el auditor revisa otra vez', async () => {
  const { engine, files } = await setup()
  const id = await start(engine)
  await engine.decide(id, { approve: false, comment: 'Otro enfoque', agents: ['story-architect'] })
  await engine.advance(id)
  await assert.rejects(engine.restore(id, 'story-architect', 2), /vigente/)
  await engine.restore(id, 'story-architect', 1)
  await engine.advance(id)
  const p = await engine.getProject(id)
  const mine = p.steps.filter((s) => s.agent === 'story-architect')
  assert.deepEqual(mine.map((s) => `${s.version} ${s.status}`), ['1 rejected', '2 rejected', '3 done'])
  assert.equal(mine[2].model, 'copia de la versión 1')
  assert.match((await files.read(`${id}/strategy/story-architect/v3/script.md`))!, /Versión: 1/)
  assert.deepEqual([p.status, p.reason], ['waiting_human', 'gate'])
  assert.equal((await engine.eventsAfter(id)).filter((e) => e.type === 'audit.verdict').length, 3)
})

test('la biblioteca de marca se guarda por cliente y llega a los agentes', async () => {
  const seen: (string | undefined)[] = []
  const spy: Runner = { ...simRunner(), runAgent: (run) => (seen.push(run.brand?.kit), simRunner().runAgent(run)) }
  const { engine } = await setup(spy)
  const { id } = await engine.createProject({ name: 'Con marca', brief: 'x', budgetCap: 100, brand: { name: 'Café Aurora', kit: 'Paleta: #5a3a1e. Nunca decir "el mejor".' } })
  await engine.advance(id)
  assert.equal(seen[0], 'Paleta: #5a3a1e. Nunca decir "el mejor".')
  assert.deepEqual(await engine.listBrands(), [{ name: 'Café Aurora', kit: 'Paleta: #5a3a1e. Nunca decir "el mejor".' }])
})

test('los archivos reales del cliente llegan a los agentes con la marca', async () => {
  const seen: string[][] = []
  const spy: Runner = { ...simRunner(), runAgent: (run) => (seen.push(run.brand?.assets ?? []), simRunner().runAgent(run)) }
  const { engine } = await setup(spy)
  await engine.addBrandAsset('Café Aurora', 'logo.png', MEDIA, 'image/png')
  const { id } = await engine.createProject({ name: 'Con logo', brief: 'x', budgetCap: 100, brand: { name: 'Café Aurora', kit: 'Tono cálido.' } })
  await engine.advance(id)
  assert.deepEqual(seen[0], [`${brandDir('Café Aurora')}/logo.png`])
  // Crear el proyecto actualiza el texto de la marca sin perder sus archivos.
  assert.equal((await engine.brandByName('Café Aurora'))?.kit, 'Tono cálido.')
})

test('cada archivo de video, imagen y audio queda guardado con su procedencia', async () => {
  const { engine, files } = await setup()
  await engine.setSettings({ humanReview: false })
  const id = await start(engine)
  const assets = await engine.listAssets(id)
  const master = assets.find((a) => a.path === 'postproduction/motion-graphics/v1/master.mp4')
  assert.deepEqual([master?.kind, master?.model], ['video', 'simulación'])
  assert.deepEqual(await files.readBytes(`${id}/postproduction/motion-graphics/v1/master.mp4`), MEDIA)
  // Lo generado con herramientas se lista en el traspaso aunque no sea un entregable fijo.
  const handoff = JSON.parse((await files.read(`${id}/production/generation-operators/v1/handoff.json`))!)
  assert.ok(handoff.files.includes('muestra.mp4'))
  assert.ok(assets.some((a) => a.path === 'production/generation-operators/v1/muestra.mp4'))
})

test('una versión nueva parte de los archivos de la anterior y conserva su procedencia', async () => {
  const found: string[][] = []
  const base = simRunner({ rejectOnce: ['preproduction'] })
  // El auditor simulado devuelve al primer agente; aquí interesa uno que genera archivos, así que se redirige.
  const spy: Runner = {
    runAuditor: async (run) => {
      const v = await base.runAuditor(run)
      return v.approved ? v : { ...v, issues: [{ agent: 'storyboard-previs', problem: 'El plano S02 no respeta la locación' }] }
    },
    runAgent: async (run) => {
      if (run.agent.id === 'storyboard-previs') found.push((await run.files.list(run.dir)).sort())
      return base.runAgent(run)
    },
  }
  const { engine } = await setup(spy)
  await engine.setSettings({ humanReview: false })
  const id = await start(engine)
  assert.deepEqual(found, [[], ['muestra.jpg', 'shots.json', 'storyboard.md']])
  const paths = (await engine.listAssets(id)).map((a) => a.path)
  assert.ok(paths.includes('preproduction/storyboard-previs/v1/muestra.jpg') && paths.includes('preproduction/storyboard-previs/v2/muestra.jpg'))
})

test('pausar y relanzar exigen el estado correcto', async () => {
  const { engine } = await setup()
  const id = await start(engine)
  await assert.rejects(engine.pause(id), /en marcha/)
  await assert.rejects(engine.rerun(id, 'art-director', 'otra paleta'), /etapa actual/)
})

test('cada agente y auditor del esquema tiene su archivo de instrucciones', () => {
  const ids = commercial.stages.flatMap((s) => [...s.agents.map((a) => a.id), s.auditor.id])
  assert.deepEqual(ids.filter((id) => !existsSync(join(root, 'server', 'agents', `${id}.md`))), [])
  assert.equal(ids.length, 32)
})

test('las migraciones se aplican una sola vez y en orden', async () => {
  const { exec } = await makePg()
  const before = await migrationStatus(exec)
  assert.equal(before.applied.length, 0)
  assert.deepEqual(await migrate(exec), before.pending)
  assert.deepEqual(await migrate(exec), [])
  assert.deepEqual((await migrationStatus(exec)).applied, before.pending)
  assert.deepEqual(before.pending, [...before.pending].sort())
})

// ---- Regresiones de la revisión de código del 17/nov/2026 ----

test('dos marcas de nombre parecido no comparten carpeta', () => {
  const dirs = ['Café Aurora', 'Cafe Aurora', 'cafe aurora', 'A&B', 'A B', '日本', '東京'].map(brandDir)
  assert.equal(new Set(dirs).size, dirs.length)
  assert.match(brandDir('Café Aurora'), /^brands\/cafe-aurora-[0-9a-f]{8}$/)
})

test('si un agente falla a medias, lo que ya generó y gastó se conserva al reintentar', async () => {
  const seen: string[][] = []
  let crash = true
  const base = simRunner()
  const flaky: Runner = {
    ...base,
    runAgent: async (run) => {
      if (run.agent.id !== 'brief-strategy') return base.runAgent(run)
      seen.push(await run.files.list(run.dir))
      if (!crash) return base.runAgent(run)
      crash = false
      await run.files.writeBytes(`${run.dir}/toma-pagada.mp4`, MEDIA, 'video/mp4')
      await run.spend(2)
      throw new Error('se cayó el proveedor')
    },
  }
  const { engine, files } = await setup(flaky)
  const id = await start(engine)
  let p = await engine.getProject(id)
  // El gasto queda registrado aunque el agente no terminara.
  assert.deepEqual([p.status, p.reason, p.spent], ['failed', 'se cayó el proveedor', 2])
  await engine.resume(id)
  await engine.advance(id)
  p = await engine.getProject(id)
  assert.equal(p.status, 'waiting_human')
  assert.deepEqual(seen, [[], ['toma-pagada.mp4']])
  assert.deepEqual(await files.readBytes(`${id}/strategy/brief-strategy/v1/toma-pagada.mp4`), MEDIA)
})

test('un reintento por entrega incompleta le dice al agente qué faltó y conserva su carpeta', async () => {
  const feedbacks: (string | null)[] = []
  let first = true
  const base = simRunner()
  const sloppy: Runner = {
    ...base,
    runAgent: async (run) => {
      if (run.agent.id !== 'brief-strategy') return base.runAgent(run)
      feedbacks.push(run.feedback)
      if (!first) return base.runAgent(run)
      first = false
      await run.files.write(`${run.dir}/borrador.md`, 'a medias')
      return { costUsd: 0, model: 'x' }
    },
  }
  const { engine, files } = await setup(sloppy)
  const id = await start(engine)
  assert.equal(feedbacks[0], null)
  assert.match(feedbacks[1]!, /incompleta: handoff\.json falta/)
  assert.equal(await files.read(`${id}/strategy/brief-strategy/v1/borrador.md`), 'a medias')
})

test('cancelar corta al agente en curso y el proyecto queda cancelado, no detenido', async () => {
  let started!: () => void
  const running = new Promise<void>((resolve) => (started = resolve))
  let aborted = false
  const slow: Runner = {
    ...simRunner(),
    runAgent: (run) => new Promise((_resolve, reject) => {
      run.signal.addEventListener('abort', () => { aborted = true; reject(run.signal.reason) })
      started()
    }),
  }
  const { engine } = await setup(slow)
  const { id } = await engine.createProject({ name: 'Largo', brief: 'x', budgetCap: 100 })
  const job = engine.advance(id)
  await running
  await engine.cancel(id)
  await job
  assert.equal(aborted, true)
  const p = await engine.getProject(id)
  assert.deepEqual([p.status, p.reason], ['cancelled', null])
  await assert.rejects(engine.resume(id), /no está pausado/)
})

test('varios problemas del auditor para un mismo agente le llegan todos', async () => {
  let first = true
  const base = simRunner()
  const picky: Runner = {
    ...base,
    runAuditor: async (run) => {
      if (!first) return base.runAuditor(run)
      first = false
      return { approved: false, costUsd: 0, issues: [{ agent: 'story-architect', problem: 'El guion dura 40 s' }, { agent: 'story-architect', problem: 'Falta la llamada a la acción' }] }
    },
  }
  const { engine } = await setup(picky)
  const p = await engine.getProject(await start(engine))
  assert.equal(p.steps.find((s) => s.agent === 'story-architect' && s.version === 1)?.feedback, 'El guion dura 40 s\nFalta la llamada a la acción')
})

test('los eventos de un proyecto conservan el orden en que ocurrieron', async () => {
  const chatty: Runner = { ...simRunner(), runAgent: async (run) => { for (let i = 0; i < 20; i++) run.say(`mensaje ${i}`); return simRunner().runAgent(run) } }
  const { engine } = await setup(chatty)
  const id = await start(engine)
  const first = (await engine.eventsAfter(id)).filter((e) => e.type === 'agent.message' && e.data.agent === 'brief-strategy' && e.data.text.startsWith('mensaje')).map((e) => e.data.text)
  assert.deepEqual(first, Array.from({ length: 20 }, (_, i) => `mensaje ${i}`))
})

test('el tope nuevo al reanudar debe superar lo ya gastado', async () => {
  const paid: Runner = { ...simRunner(), runAgent: async (run) => ({ ...(await simRunner().runAgent(run)), costUsd: 2 }) }
  const { engine } = await setup(paid)
  const id = await start(engine, 3)
  assert.equal((await engine.getProject(id)).reason, 'budget')
  await assert.rejects(engine.resume(id, 4), /mayor que lo ya gastado/)
})

test('la subida de marca decide el tipo por el contenido y rechaza lo que no es imagen', async () => {
  const { engine } = await setup()
  const app = createApp({ engine, publicConfig: { supabaseUrl: '', supabaseAnonKey: '' }, auth: async (t) => (t === 'ok' ? 'qa' : null) })
  const send = (bytes: Uint8Array | string, type: string, kind: string) => {
    const form = new FormData()
    form.set('file', new File([bytes as BlobPart], 'x', { type })); form.set('kind', kind)
    return app.request('/api/brands/Marca/assets', { method: 'POST', body: form, headers: { authorization: 'Bearer ok' } })
  }
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
  assert.equal((await app.request('/api/brands/Marca/assets', { method: 'POST' })).status, 401)
  // Declarar "image/png" no basta: manda el contenido.
  assert.equal((await send('%PDF-1.7 no soy una imagen', 'image/png', 'product')).status, 400)
  assert.equal((await send('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'image/svg+xml', 'logo')).status, 400)
  assert.equal((await send('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"></svg>', 'image/svg+xml', 'logo')).status, 400)
  assert.equal((await send('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>', 'image/svg+xml', 'product')).status, 400)
  assert.deepEqual(await (await send('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>', 'image/svg+xml', 'logo')).json(), ['logo.svg'])
  // El nombre y la extensión los pone el servidor, aunque el navegador declare otra cosa.
  assert.deepEqual(await (await send(jpg, 'image/png', 'product')).json(), ['logo.svg', 'producto-1.jpg'])
  assert.deepEqual(await (await send(png, 'application/octet-stream', 'product')).json(), ['logo.svg', 'producto-1.jpg', 'producto-2.png'])
  assert.equal((await send(new Uint8Array(6 * 1024 * 1024), 'image/png', 'product')).status, 413)
  // Rutas de archivo: nada fuera del proyecto ni de la marca.
  const get = (path: string) => app.request(path, { headers: { authorization: 'Bearer ok' } })
  assert.equal((await get('/api/brands/Marca/files/..%2F..%2Fx')).status, 404)
  assert.equal((await get('/api/brands/Marca/files/logo.svg')).headers.get('content-security-policy'), "sandbox; default-src 'none'")
})
