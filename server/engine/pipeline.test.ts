import { priceList } from '../media/prices.ts'
import { usdOf } from './models.ts'
import { readReferences } from './types.ts'
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
import { createTelegram } from '../telegram.ts'
import { parseSuggestion, simExplorer } from '../explore.ts'
import { createUsers } from '../users.ts'
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
  return { engine: createEngine({ db, files, schemes: { commercial }, runner, explorer: simExplorer(async () => MEDIA) }), db, files }
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

test('un proyecto conserva el modo con el que se creó aunque cambie el interruptor', async () => {
  const { engine } = await setup()
  const sim = await engine.createProject({ name: 'Simulado', brief: 'x', budgetCap: 5 })
  await engine.setSettings({ simulation: false })
  const real = await engine.createProject({ name: 'Real', brief: 'x', budgetCap: 5 })
  assert.equal((await engine.getProject(sim.id)).simulation, true)
  assert.equal((await engine.getProject(real.id)).simulation, false)
})

test('el tope se puede subir sin pausar, nunca por debajo de lo gastado', async () => {
  const { engine } = await setup()
  const { id } = await engine.createProject({ name: 'Tope', brief: 'x', budgetCap: 5 })
  assert.equal((await engine.setBudget(id, 12)).budget_cap, 12)
  await assert.rejects(engine.setBudget(id, 0), /mayor que lo ya gastado/)
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

test('las fotos de referencia subidas en una aprobación quedan en el proyecto y se nombran al devolver', async () => {
  const seen: (string | null)[] = []
  const spy: Runner = { ...simRunner(), runAgent: (run) => (seen.push(run.feedback), simRunner().runAgent(run)) }
  const { engine } = await setup(spy)
  const id = await start(engine)
  const refs = await engine.addReference(id, MEDIA, '.jpg', 'image/jpeg', 'Así debe verse la taza')
  assert.deepEqual(refs, [{ file: 'referencias/ref-1.jpg', note: 'Así debe verse la taza', stage: engine.schemes.commercial.stages[0].name }])
  assert.ok(await engine.files.readBytes(`${id}/referencias/ref-1.jpg`))
  await engine.decide(id, { approve: false, comment: 'Usa la taza real', references: ['referencias/ref-1.jpg', 'otra/cosa.jpg'] })
  await engine.advance(id)
  const feedback = seen.filter(Boolean).pop()!
  assert.match(feedback, /Usa la taza real\n.*referencias\/ref-1\.jpg$/)
  assert.doesNotMatch(feedback, /otra\/cosa/)
  assert.deepEqual(await engine.listReferences(id), refs)
})

test('las referencias subidas al crear el proyecto existen antes de que trabaje el primer agente', async () => {
  const seen: number[] = []
  const spy: Runner = { ...simRunner(), runAgent: async (run) => (seen.push((await readReferences(run.files, run.project.id)).length), simRunner().runAgent(run)) }
  const { engine } = await setup(spy)
  const { id } = await engine.createProject({ name: 'Con referencias', brief: 'x', budgetCap: 100, references: [1, 2].map(() => ({ bytes: MEDIA, ext: '.jpg', contentType: 'image/jpeg', note: 'El tono de luz' })) })
  await engine.advance(id)
  assert.equal(seen[0], 2)
  assert.deepEqual((await engine.listReferences(id)).map((r) => [r.file, r.stage]), [['referencias/ref-1.jpg', ''], ['referencias/ref-2.jpg', '']])
})

test('la configuración elige el modelo de cada agente y rechaza valores que no existen', async () => {
  const seen = new Map<string, string | undefined>()
  let video: string | undefined
  const spy: Runner = { ...simRunner(), runAgent: (run) => (seen.set(run.agent.id, run.model), (video = run.media?.video), simRunner().runAgent(run)) }
  const { engine } = await setup(spy)
  await engine.setSettings({ models: { 'brand-market-research': 'claude-haiku-5-5' }, textTimeoutMin: 20 })
  await assert.rejects(engine.setSettings({ models: { 'brand-market-research': 'gpt-x' } }), /no sirve/)
  await assert.rejects(engine.setSettings({ models: { 'nadie': 'claude-haiku-5-5' } }), /no sirve/)
  await assert.rejects(engine.setSettings({ maxAuditRetries: 9 }), /no sirve/)
  await assert.rejects(engine.setSettings({ videoModel: 'sora' }), /no sirve/)
  await engine.setSettings({ videoModel: 'kling-3-standard' })
  assert.match(priceList(undefined, 'kling-3-standard'), /kling-video\/v3\/standard\/image-to-video, sin audio\): 0\.084/)
  assert.match(priceList(), /nano-banana-2\): 0\.08 .*\n.*\n.*kling-video\/v2\.6\/pro/)
  await start(engine)
  assert.equal(seen.get('brand-market-research'), 'claude-haiku-5-5')
  assert.equal(seen.get('brief-strategy'), undefined)
  assert.equal(video, 'kling-3-standard')
  assert.equal((await engine.getSettings()).textTimeoutMin, 20)
  // Un valor malo no deja guardado a medias lo demás del mismo cambio.
  await assert.rejects(engine.setSettings({ simulation: false, maxAuditRetries: 9 }), /no sirve/)
  assert.equal((await engine.getSettings()).simulation, true)
  await assert.rejects(engine.setSettings({ models: { 'brief-strategy': 'constructor' } }), /no sirve/)
  // Los modelos se fusionan por agente: un cambio no pisa a otro, y null o el modelo por defecto quitan la elección.
  await engine.setSettings({ models: { 'story-architect': 'claude-opus-5-5' } })
  assert.deepEqual((await engine.getSettings()).models, { 'brand-market-research': 'claude-haiku-5-5', 'story-architect': 'claude-opus-5-5' })
  await engine.setSettings({ models: { 'brand-market-research': null, 'story-architect': 'claude-sonnet-5-5' } })
  assert.deepEqual((await engine.getSettings()).models, {})
})

test('los tokens de cada respuesta quedan en el informe de costos, con el precio de su modelo', async () => {
  const use = { model: 'claude-haiku-5-5', input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 }
  assert.ok(Math.abs(usdOf(use) - 0.5) < 1e-9, 'Haiku por encima de 100 000 tokens de entrada cobra la tarifa alta')
  assert.ok(Math.abs(usdOf({ model: 'claude-sonnet-5-5', input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 1e6 }) - 14.6) < 1e-9)
  let once = true
  const spy: Runner = { ...simRunner(), runAgent: async (run) => { if (once) { once = false; await run.spend(usdOf(use), use) } return simRunner().runAgent(run) } }
  const { engine } = await setup(spy)
  const id = await start(engine)
  const report = await engine.costReport(id)
  assert.equal(report.tokens.input, 1_000_000)
  assert.ok(Math.abs(report.tokensUsd.input - 0.5) < 1e-9)
  assert.deepEqual(report.byModel, [{ model: 'Haiku 5.5', usd: 0.5 }])
})

test('con exploración el proyecto espera, lo elegido se vuelve referencia y recién entonces arranca', async () => {
  let ran = 0
  const spy: Runner = { ...simRunner(), runAgent: (run) => (ran++, simRunner().runAgent(run)) }
  const { engine } = await setup(spy)
  const { id, status } = await engine.createProject({ name: 'Con exploración', brief: 'Comercial de 15 s', budgetCap: 100, explore: true })
  await engine.advance(id)
  assert.deepEqual([status, ran], ['exploring', 0], 'nada corre mientras se explora')
  const proposed = await engine.suggestExploration(id)
  assert.equal(proposed.boards.length, 3)
  const board = proposed.boards[0]
  await assert.rejects(engine.generateExploration(id, 'no-existe'), /ya no existe/)
  await assert.rejects(engine.shareMoodboard(id, 'qa@example.com'), /Elige al menos una/)
  const made = await engine.generateExploration(id, board.id, 4)
  const images = made.boards[0].images
  assert.equal(images.length, 4)
  // Editar los textos no pierde las imágenes, y quitar un tablero sí lo quita.
  const saved = await engine.saveExploration(id, { idea: 'Una mañana cualquiera', boards: [{ id: board.id, title: 'La protagonista', prompt: board.prompt, note: 'Misma persona en todos los planos', aspect: '3:4' }] })
  assert.deepEqual([saved.boards.length, saved.boards[0].images.length, saved.boards[0].title], [1, 4, 'La protagonista'])
  await engine.selectExploration(id, images[1].file, true)
  const { token } = await engine.shareMoodboard(id, 'qa@example.com')
  const share = await engine.openShare(token)
  assert.ok(token.startsWith('m-'))
  assert.deepEqual([share!.moodboard.idea, Object.values(share!.moodboard.paths), share!.report, share!.videos.length], ['Una mañana cualquiera', [images[1].file], '', 0])
  await engine.startProduction(id)
  await assert.rejects(engine.startProduction(id), /ya no está en exploración/)
  await assert.rejects(engine.generateExploration(id, board.id), /ya no está en exploración/)
  await engine.advance(id)
  assert.ok(ran > 0, 'al iniciar, los agentes trabajan')
  assert.deepEqual(await engine.listReferences(id), [{ file: 'referencias/ref-1.jpg', note: 'La protagonista. Misma persona en todos los planos', stage: '' }])
  assert.equal((await engine.listAssets(id)).filter((a) => a.path.startsWith('exploracion/')).length, 4, 'cada opción generada queda con su procedencia')
})

test('la exploración no gasta por encima del tope y la propuesta del modelo se valida', async () => {
  const paid = simExplorer(async () => MEDIA)
  const db = await makeDb(), files = memoryFiles()
  const engine = createEngine({ db, files, schemes: { commercial }, runner: simRunner(), explorer: { ...paid, image: async (o) => ({ ...(await paid.image(o)), costUsd: 0.08 }) } })
  await engine.setSettings({ simulation: false })
  const { id } = await engine.createProject({ name: 'Justo', brief: 'x', budgetCap: 1, explore: true })
  const { boards } = await engine.suggestExploration(id)
  await engine.generateExploration(id, boards[0].id, 4)
  await engine.generateExploration(id, boards[0].id, 4)
  await engine.generateExploration(id, boards[0].id, 4)
  await assert.rejects(engine.generateExploration(id, boards[0].id, 4), /Falta presupuesto/)
  assert.ok(Math.abs((await engine.getProject(id)).spent - 0.96) < 1e-9)
  // Dos generaciones a la vez no pasan el tope entre las dos: la segunda ve lo que la primera apartó.
  const tight = await engine.createProject({ name: 'A la vez', brief: 'x', budgetCap: 0.4, explore: true })
  const two = (await engine.suggestExploration(tight.id)).boards
  const both = await Promise.allSettled([engine.generateExploration(tight.id, two[0].id, 4), engine.generateExploration(tight.id, two[1].id, 4)])
  assert.deepEqual(both.map((r) => r.status).sort(), ['fulfilled', 'rejected'])
  assert.ok((await engine.getProject(tight.id)).spent <= 0.4 + 1e-9)
  // Pedir más propuestas no borra los tableros ya escritos.
  assert.equal((await engine.suggestExploration(tight.id)).boards.length, 6)
  // Con las referencias casi llenas, iniciar avisa antes de copiar nada y el proyecto sigue en exploración.
  for (let n = 0; n < 29; n++) await engine.addReference(tight.id, MEDIA, '.jpg', 'image/jpeg', '')
  const made = (await engine.getExploration(tight.id)).boards.flatMap((b) => b.images)
  await engine.selectExploration(tight.id, made[0].file, true)
  await engine.selectExploration(tight.id, made[1].file, true)
  await assert.rejects(engine.startProduction(tight.id), /elige como máximo 1/)
  assert.deepEqual([(await engine.getProject(tight.id)).status, (await engine.listReferences(tight.id)).length], ['exploring', 29])
  assert.deepEqual(parseSuggestion('Claro:\n{"idea":"i","boards":[{"title":"Look","prompt":"a warm kitchen at dawn","aspect":"2:1"},{"title":"","prompt":"x"}]}').boards, [{ title: 'Look', prompt: 'a warm kitchen at dawn', note: '', aspect: '16:9' }])
  assert.throws(() => parseSuggestion('no hay json'), /No se pudo armar/)
})

test('una mejora pedida tras la entrega reabre la etapa y las siguientes, sube el tope y vuelve a entregar', async () => {
  const { engine } = await setup()
  await engine.setSettings({ humanReview: false })
  const id = await start(engine)
  assert.equal((await engine.getProject(id)).status, 'done')
  await assert.rejects(engine.requestImprovement(id, 'production', 'Cambia la toma 2 por una más luminosa', 0, 'qa@example.com'), /cuánto se puede gastar/)
  await assert.rejects(engine.requestImprovement(id, 'no-existe', 'Cambia la toma 2 por una más luminosa', 5, 'qa@example.com'), /no existe/)
  await engine.requestImprovement(id, 'production', 'Cambia la toma 2 por una más luminosa', 5, 'qa@example.com')
  await assert.rejects(engine.requestImprovement(id, 'production', 'Otra mejora distinta de la anterior', 5, 'qa@example.com'), /ya entregada/)
  await engine.advance(id)
  const p = await engine.getProject(id)
  assert.deepEqual([p.status, p.budget_cap], ['done', 105])
  const redone = (stage: string) => p.steps.filter((s) => s.stage === stage && s.version === 2).length
  // La etapa pedida y todo lo que depende de ella se rehízo; lo anterior no se tocó.
  assert.ok(redone('production') > 0 && redone('postproduction') > 0 && redone('delivery') > 0)
  assert.deepEqual([redone('strategy'), redone('preproduction')], [0, 0])
  assert.match(p.steps.find((s) => s.stage === 'production' && s.version === 1)!.feedback!, /Mejora pedida por la persona.*toma 2/s)
})

test('con el trabajo en paralelo corren a la vez solo los agentes que el esquema marca como independientes', async () => {
  const peak = async (parallelAgents: boolean) => {
    let now = 0, max = 0
    const together = new Set<string>()
    const base = simRunner()
    const spy: Runner = { ...base, runAgent: async (run) => { now++; max = Math.max(max, now); if (now > 1) together.add(run.agent.id); await new Promise((r) => setTimeout(r, 5)); try { return await base.runAgent(run) } finally { now-- } } }
    const { engine } = await setup(spy)
    await engine.setSettings({ humanReview: false, parallelAgents })
    const id = await start(engine)
    assert.equal((await engine.getProject(id)).status, 'done')
    return { max, together }
  }
  assert.equal((await peak(false)).max, 1)
  const on = await peak(true)
  assert.ok(on.max > 1)
  for (const id of on.together) assert.ok(commercial.stages.flatMap((s) => s.agents).find((a) => a.id === id)!.alongside, `${id} corrió en paralelo sin estar marcado`)
})

test('el cliente opina desde su enlace y queda pendiente para el estudio; una plantilla trae las referencias', async () => {
  const { engine } = await setup()
  const { id } = await engine.createProject({ name: 'Con cliente', brief: 'Comercial de 15 s', budgetCap: 100, explore: true })
  const { boards } = await engine.suggestExploration(id)
  const { boards: made } = await engine.generateExploration(id, boards[0].id, 2)
  await engine.selectExploration(id, made[0].images[0].file, true)
  const { token } = await engine.shareMoodboard(id, 'qa@example.com')
  assert.equal(await engine.addClientFeedback('no-existe-este-token-000000', { kind: 'approve' }), null)
  await assert.rejects(engine.addClientFeedback(token, { kind: 'comment', text: '' }), /Escribe tu comentario/)
  await engine.addClientFeedback(token, { kind: 'comment', text: 'Más luz en la cocina', name: 'Ana', target: 'Locación' })
  await engine.addClientFeedback(token, { kind: 'approve', name: 'Ana' })
  const notes = await engine.listClientFeedback(id)
  assert.deepEqual(notes.map((n) => [n.kind, n.about, n.status, n.text]), [['comment', 'moodboard', 'new', 'Más luz en la cocina'], ['approve', 'moodboard', 'new', '']])
  assert.equal((await engine.resolveClientFeedback(id, notes[0].id, 'used'))[0].status, 'used')
  await assert.rejects(engine.resolveClientFeedback(id, notes[0].id, 'otra'), /usado o como descartado/)
  await engine.startProduction(id)
  const copy = await engine.createProject({ name: 'Siguiente', brief: 'Otro comercial', budgetCap: 100, explore: true, templateId: id })
  assert.deepEqual((await engine.listReferences(copy.id)).map((r) => r.note), (await engine.listReferences(id)).map((r) => r.note))
  await assert.rejects(engine.createProject({ name: 'Sin base', brief: 'x', budgetCap: 100, templateId: 'p_noexiste' }))
})

test('Telegram: se enlaza con un código de un solo uso y solo quien tiene acceso recibe avisos y decide', async () => {
  const db = await makeDb()
  const sent: { method: string; body: any }[] = []
  const request = (async (url: string, init: any) => { sent.push({ method: String(url).split('/').pop()!, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ ok: true, result: { username: 'PanaBot' } })) }) as unknown as typeof fetch
  const decided: string[] = []
  const access = new Map<string, 'admin' | 'member'>([['ana@example.com', 'member']])
  const card = { id: 'p_1', name: 'Café <Aurora>', status: 'waiting_human', reason: 'gate', spent: 10, cap: 40, at: 2, stage: { id: 'production', name: 'Production', gate: 'Tomas finales' }, stages: ['strategy', 'preproduction', 'production', 'postproduction', 'delivery'].map((id) => ({ id, label: id.slice(0, 4), name: id })) }
  const studio = {
    roleOf: async (e: string) => access.get(e) ?? null, card: async () => ({ ...card }), list: async () => [{ ...card }],
    audit: async () => ({ approved: true, attempt: 1, issues: [], agents: 5, files: 9 }), delivered: async () => [{ agent: 'Editor', version: 2, files: ['cut.mp4'] }],
    summary: async () => ({ minutes: 75, reworks: 1, totalUsd: 10, modelUsd: 8, generationUsd: 2, reworkUsd: 1, byStage: [{ name: 'Production', usd: 10 }] }),
    approve: async (p: string, st: string, e: string) => { if (st !== 'production') throw Object.assign(new Error('avanzó'), { stale: true }); decided.push(`ok ${p} ${st} ${e}`) },
    sendBack: async (p: string, st: string, _e: string, c: string) => void decided.push(`no ${p} ${st} ${c}`),
    raise: async (p: string, n: number) => { decided.push(`up ${p} ${n}`); return { ...card, cap: 40 + n } }, cancel: async (p: string) => void decided.push(`cancel ${p}`), retry: async (p: string) => void decided.push(`retry ${p}`),
    improve: async (p: string, st: string, t: string, b: number) => void decided.push(`improve ${p} ${st} ${b} ${t}`),
    note: async (_p: string, n: string) => ({ id: n, kind: 'comment', about: 'pieza', name: 'Ana', text: 'El final más lento' }), resolve: async (p: string, n: string, s: string) => void decided.push(`note ${n} ${s}`),
  }
  const telegram = createTelegram({ db, token: 't', studio, request })
  const texts = () => sent.filter((s) => s.method === 'sendMessage' || s.method === 'editMessageText').map((s) => s.body.text as string)
  const press = (data: string, chat = 7, id = 1) => telegram.handle({ update_id: id, callback_query: { id: 'c', data, message: { message_id: 55, chat: { id: chat } } } })
  assert.deepEqual(await telegram.status('ana@example.com'), { enabled: true, linked: false })
  const { code, link } = await telegram.link('ana@example.com')
  assert.equal(link, `https://t.me/PanaBot?start=${code}`)
  await telegram.handle({ update_id: 1, message: { chat: { id: 7 }, text: '/start AAAAAAAAAAAA' } })
  assert.match(texts().at(-1)!, /no existe o ya venció/)
  await telegram.handle({ update_id: 2, message: { chat: { id: 7 }, text: `/start ${code}` } })
  assert.equal((await telegram.status('ana@example.com')).linked, true)
  await telegram.handle({ update_id: 3, message: { chat: { id: 8 }, text: `/start ${code}` } })
  assert.match(texts().at(-1)!, /no existe o ya venció/, 'el código no sirve dos veces')
  // El aviso de etapa lleva el nombre escapado, el recorrido, la barra de presupuesto y sus botones.
  await telegram.announce('p_1')
  const gate = sent.at(-1)!.body
  assert.match(gate.text, /Café &lt;Aurora&gt;.*Production espera tu aprobación.*✅ stra.*🟡 prod.*▰▰▰▱/s)
  assert.deepEqual(gate.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data), ['ok:p_1:production', 'no:p_1:production', 'ver:p_1'])
  // Aprobar reescribe el mismo aviso; devolver pide el texto y luego devuelve.
  await press('ok:p_1:production')
  assert.deepEqual([sent.at(-1)!.method, sent.at(-1)!.body.message_id], ['editMessageText', 55])
  assert.match(texts().at(-1)!, /aprobada/)
  await press('no:p_1:production')
  await telegram.handle({ update_id: 6, message: { chat: { id: 7 }, text: 'Falta el producto en el plano 3' } })
  assert.match(texts().at(-1)!, /devuelta.*Falta el producto/s)
  assert.deepEqual(decided, ['ok p_1 production ana@example.com', 'no p_1 production Falta el producto en el plano 3'])
  // Un aviso viejo avisa que ya no vale, y un botón desconocido no hace nada.
  await press('ok:p_1:strategy')
  assert.match(texts().at(-1)!, /Ese aviso ya no vale/)
  const quiet = sent.filter((s) => s.method !== 'answerCallbackQuery').length
  await press('ejemplo')
  assert.equal(sent.filter((s) => s.method !== 'answerCallbackQuery').length, quiet)
  // El dinero es cosa de administradores: un miembro no sube el tope, no cancela ni pide mejoras.
  for (const data of ['up:p_1:10', 'cx:p_1', 'cy:p_1', 'im:p_1']) { await press(data); assert.match(texts().at(-1)!, /solo lo puede hacer un administrador/) }
  access.set('ana@example.com', 'admin')
  await press('up:p_1:10')
  assert.match(texts().at(-1)!, /Tope subido a \$50\.00/)
  await press('up:p_1:999')
  // Cancelar pide una segunda pulsación.
  await press('cx:p_1')
  assert.deepEqual(sent.at(-1)!.body.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data), ['cy:p_1', 'cn:p_1'])
  assert.ok(!decided.some((d) => d.startsWith('cancel')))
  await press('cy:p_1')
  // Mejora tras la entrega: etapa, texto y tope, en ese orden.
  await press('im:p_1'); await press('is:p_1:postproduction')
  await telegram.handle({ update_id: 9, message: { chat: { id: 7 }, text: 'Sube el volumen de la música al final' } })
  await press('ib:p_1:10')
  // El comentario del cliente, con la producción esperando decisión, devuelve la etapa.
  await telegram.announce('p_1', { id: 'abc123', kind: 'comment', about: 'pieza', name: 'Ana', text: 'El final más lento' })
  assert.deepEqual(sent.at(-1)!.body.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data), ['fu:p_1:abc123', 'fd:p_1:abc123'])
  await press('fu:p_1:abc123')
  assert.deepEqual(decided.slice(2), ['up p_1 10', 'cancel p_1', 'improve p_1 postproduction 10 Sube el volumen de la música al final', 'no p_1 production El final más lento', 'note abc123 used'])
  await telegram.handle({ update_id: 10, message: { chat: { id: 7 }, text: '/estado' } })
  assert.match(texts().at(-1)!, /Tus producciones/)
  // Un chat sin enlazar, o de alguien que perdió el acceso, no decide ni recibe avisos.
  await press('ok:p_1:production', 99)
  access.clear()
  await press('ok:p_1:production')
  const before = sent.length
  await telegram.announce('p_1')
  assert.deepEqual([decided.length, sent.length], [7, before])
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
  assert.deepEqual(found, [[], ['animatic.mp4', 'muestra.jpg', 'shots.json', 'storyboard.md']])
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
  const app = createApp({ engine, publicConfig: { supabaseUrl: '', supabaseAnonKey: '' }, auth: async (t) => (t === 'ok' ? { email: 'qa@pana.test', role: 'admin' } : null) })
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

test('desde un gate se puede devolver trabajo a una etapa anterior y lo posterior se actualiza', async () => {
  const runs: string[] = []
  const base = simRunner()
  const spy: Runner = { ...base, runAgent: (run) => (runs.push(`${run.agent.id} v${run.version}`), base.runAgent(run)) }
  const { engine } = await setup(spy)
  const id = await start(engine)
  await engine.decide(id, { approve: true })
  await engine.advance(id)
  // En el gate de Pre-production se descubre un problema del guion, que es de la etapa 1.
  runs.length = 0
  await engine.decide(id, { approve: false, comment: 'El guion dura 40 s', agents: ['story-architect'] })
  await engine.advance(id)
  let p = await engine.getProject(id)
  // Se rehace el guion y lo que venía después en su etapa; la etapa 1 vuelve a pedir aprobación.
  assert.deepEqual(runs, ['story-architect v2', 'concept-pitch v2'])
  assert.deepEqual([p.status, p.currentStage], ['waiting_human', 'strategy'])
  assert.equal(p.steps.find((s) => s.agent === 'story-architect' && s.version === 1)?.feedback, 'El guion dura 40 s')
  assert.match(p.steps.find((s) => s.agent === 'concept-pitch' && s.version === 1)?.feedback ?? '', /Se devolvió trabajo anterior al tuyo \(Story Architect Agent\)/)
  assert.equal(p.steps.find((s) => s.agent === 'brief-strategy')?.status, 'done')
  // Al aprobarla, toda la etapa 2 se actualiza partiendo de sus archivos anteriores.
  runs.length = 0
  await engine.decide(id, { approve: true })
  await engine.advance(id)
  p = await engine.getProject(id)
  assert.deepEqual(runs, commercial.stages[1].agents.map((a) => `${a.id} v2`))
  assert.deepEqual([p.status, p.currentStage], ['waiting_human', 'preproduction'])
})

test('a un agente devuelto que termina sin cambiar nada se le avisa una vez', async () => {
  const feedbacks: (string | null)[] = []
  let rejected = false
  const base = simRunner()
  // Un agente real que dice haber corregido pero no toca ningún archivo: su traspaso llega con `changed` vacío.
  const lazy: Runner = {
    runAuditor: async (run) => (rejected ? base.runAuditor(run) : ((rejected = true), { approved: false, costUsd: 0, issues: [{ agent: 'story-architect', problem: 'El guion dura 40 s' }] })),
    runAgent: async (run) => {
      const result = await base.runAgent(run)
      if (run.agent.id !== 'story-architect' || run.version === 1) return result
      feedbacks.push(run.feedback)
      const path = `${run.dir}/handoff.json`
      const handoff = JSON.parse((await run.files.read(path))!)
      await run.files.write(path, JSON.stringify({ ...handoff, changed: feedbacks.length === 1 ? [] : ['script.md'] }))
      return result
    },
  }
  const { engine } = await setup(lazy)
  const id = await start(engine)
  assert.equal(feedbacks.length, 2)
  assert.equal(feedbacks[0], 'El guion dura 40 s')
  assert.match(feedbacks[1]!, /terminaste sin escribir ni generar ningún archivo/)
  assert.equal((await engine.getProject(id)).status, 'waiting_human')
})

// ---- Regresiones de la segunda revisión de código (17/nov/2026) ----

test('una decisión se toma una sola vez y no resucita un proyecto cancelado', async () => {
  const { engine } = await setup()
  const id = await start(engine)
  // Doble clic: la segunda decisión llega cuando la primera ya movió el proyecto.
  const results = await Promise.allSettled([engine.decide(id, { approve: true }), engine.decide(id, { approve: true })])
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected'])
  await engine.advance(id)
  assert.equal((await engine.eventsAfter(id)).filter((e) => e.type === 'gate.decided').length, 1)
  // Cancelado en el gate: una devolución tardía ya no lo pone en marcha.
  await engine.cancel(id)
  await assert.rejects(engine.decide(id, { approve: false, comment: 'tarde' }), /no está esperando/)
  assert.equal((await engine.getProject(id)).status, 'cancelled')
})

test('no se puede devolver trabajo a un agente de una etapa posterior', async () => {
  const { engine } = await setup()
  const id = await start(engine)
  await assert.rejects(engine.decide(id, { approve: false, comment: 'x', agents: ['editor'] }), /no es de esta etapa ni de una anterior/)
  assert.equal((await engine.getProject(id)).status, 'waiting_human')
})

test('al retomar una versión interrumpida se trae de la anterior solo lo que falta', async () => {
  const seen: string[][] = []
  let crash = true, rejected = false
  const base = simRunner()
  const flaky: Runner = {
    runAuditor: async (run) => (rejected ? base.runAuditor(run) : ((rejected = true), { approved: false, costUsd: 0, issues: [{ agent: 'story-architect', problem: 'Acorta el guion' }] })),
    runAgent: async (run) => {
      if (run.agent.id !== 'story-architect' || run.version === 1) return base.runAgent(run)
      seen.push((await run.files.list(run.dir)).sort())
      if (!crash) return base.runAgent(run)
      crash = false
      // Reescribe un entregable, deja uno propio y se cae antes de terminar.
      await run.files.write(`${run.dir}/script.md`, 'guion corregido a medias')
      await run.files.write(`${run.dir}/notas.md`, 'apuntes')
      await run.files.removeDir(run.dir.replace('/v2', '/v2-no-existe'))
      throw new Error('se cayó')
    },
  }
  const { engine, files } = await setup(flaky)
  const id = await start(engine)
  assert.equal((await engine.getProject(id)).status, 'failed')
  // Simula que la caída ocurrió antes de copiar la Story Bible de la versión 1.
  const dir = `${id}/strategy/story-architect/v2`
  const kept = new Map<string, Uint8Array>()
  for (const f of ['script.md', 'notas.md']) kept.set(f, (await files.readBytes(`${dir}/${f}`))!)
  await files.removeDir(dir)
  for (const [f, bytes] of kept) await files.writeBytes(`${dir}/${f}`, bytes, 'text/plain')
  await engine.resume(id)
  await engine.advance(id)
  assert.deepEqual(seen, [['script.md', 'story-bible.md'], ['notas.md', 'script.md', 'story-bible.md']])
})

test('un reintento no arranca si el intento anterior agotó el presupuesto', async () => {
  let calls = 0
  const base = simRunner()
  const greedy: Runner = {
    ...base,
    runAgent: async (run) => {
      if (run.agent.id !== 'brief-strategy') return base.runAgent(run)
      calls++
      await run.spend(5)
      return { costUsd: 0, model: 'x' } // entrega incompleta: provocaría un reintento
    },
  }
  const { engine } = await setup(greedy)
  const p = await engine.getProject(await start(engine, 5))
  assert.deepEqual([calls, p.status, p.reason, p.spent], [1, 'paused', 'budget', 5])
})

// ---- Administración, equipo y vistas previas para clientes ----

test('el informe de costos separa la primera pasada de las repeticiones y cuadra con lo gastado', async () => {
  const base = simRunner({ rejectOnce: ['strategy'] })
  const paid: Runner = {
    runAgent: async (run) => { await run.spend(run.agent.id === 'story-architect' ? 2 : 1); return base.runAgent(run) },
    runAuditor: async (run) => { await run.spend(0.5); return base.runAuditor(run) },
  }
  const { engine } = await setup(paid)
  const id = await start(engine)
  const r = await engine.costReport(id)
  // 4 agentes + auditoría rechazada, luego se repite el primero y se audita otra vez.
  assert.deepEqual([r.totalUsd, r.firstPassUsd, r.reworkUsd, r.rejections], [7, 5.5, 1.5, 1])
  assert.deepEqual(r.byStage[0], { id: 'strategy', name: 'Strategy & Development', usd: 7, firstPassUsd: 5.5, reworkUsd: 1.5, runs: 7, repeats: 2 })
  assert.deepEqual(r.byAgent.slice(0, 2).map((a) => [a.id, a.usd, a.runs, a.repeats]), [['brief-strategy', 2, 2, 1], ['story-architect', 2, 1, 0]])
  assert.equal(r.runs.length, 7)
  const [row] = await engine.overview()
  assert.deepEqual([row.id, row.spent, row.runs, row.reworks, row.approved, row.stages, row.master], [id, 7, 5, 1, 0, 5, null])
})

test('borrar una producción se lleva sus archivos, y exige que no esté en marcha', async () => {
  const { engine, files } = await setup()
  await engine.setSettings({ humanReview: false })
  const id = await start(engine)
  const master = `${id}/postproduction/motion-graphics/v1/master.mp4`
  assert.ok(await files.readBytes(master))
  const share = await engine.createShare(id, 'qa@pana.test')
  await engine.deleteProject(id)
  assert.equal(await files.readBytes(master), null)
  assert.equal(await files.read(`${id}/client/report.md`), null)
  assert.deepEqual(await engine.overview(), [])
  assert.equal(await engine.openShare(share.token), null)
  await assert.rejects(engine.getProject(id), /no encontrado/)
})

test('un cliente ve la pieza y la memoria con su enlace, y nada más', async () => {
  const { engine } = await setup()
  await engine.setSettings({ humanReview: false })
  const id = await start(engine)
  const users = createUsers({ db: async () => [], owners: [], identity: { create: async () => {}, remove: async () => {} } })
  const app = createApp({ engine, users, publicConfig: { supabaseUrl: '', supabaseAnonKey: '' }, auth: async (t) => (t === 'admin' ? { email: 'jefa@pana.test', role: 'admin' } : t === 'miembro' ? { email: 'edita@pana.test', role: 'member' } : null) })
  const as = (token: string, path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers } })

  // Solo un administrador comparte, y solo cuando hay pieza que enseñar.
  assert.equal((await as('miembro', `/api/admin/projects/${id}/shares`, { method: 'POST', body: '{}' })).status, 403)
  const { token } = await (await as('admin', `/api/admin/projects/${id}/shares`, { method: 'POST', body: '{"days":7}' })).json()
  assert.match(token, /^[\w-]{32}$/)

  // Sin sesión: el enlace basta para ver, y un secreto inventado no revela nada.
  const page = await (await app.request(`/api/public/${token}`)).json()
  assert.deepEqual([page.name, page.videos.map((v: any) => v.label)], ['Prueba', ['Pieza principal', 'Versión']])
  assert.match(page.report, /## La idea/)
  assert.equal(page.projectId, undefined)
  assert.equal((await app.request(`/api/public/${'x'.repeat(32)}`)).status, 404)
  assert.equal((await app.request(`/api/projects/${id}`)).status, 401)

  // El video admite peticiones por tramos, que es como lo pide un navegador.
  const whole = await app.request(`/api/public/${token}/video/0`)
  assert.deepEqual([whole.status, whole.headers.get('content-type'), (await whole.arrayBuffer()).byteLength], [200, 'video/mp4', 3])
  const part = await app.request(`/api/public/${token}/video/0`, { headers: { range: 'bytes=1-' } })
  assert.deepEqual([part.status, part.headers.get('content-range'), new Uint8Array(await part.arrayBuffer())], [206, 'bytes 1-2/3', new Uint8Array([2, 3])])
  assert.equal((await app.request(`/api/public/${token}/video/9`)).status, 404)

  // Las visitas se cuentan y el enlace se puede revocar.
  const [share] = await (await as('admin', `/api/admin/projects/${id}/shares`)).json()
  assert.deepEqual([share.views, share.active, share.createdBy], [1, true, 'jefa@pana.test'])
  assert.equal((await as('admin', `/api/admin/projects/${id}/shares/${token}`, { method: 'DELETE' })).status, 200)
  assert.equal((await app.request(`/api/public/${token}`)).status, 404)
  assert.equal((await app.request(`/api/public/${token}/video/0`)).status, 404)

  // Borrar exige escribir el nombre exacto.
  assert.equal((await as('admin', `/api/admin/projects/${id}`, { method: 'DELETE', body: '{"confirm":"otra"}' })).status, 400)
  assert.equal((await as('admin', `/api/admin/projects/${id}`, { method: 'DELETE', body: '{"confirm":"Prueba"}' })).status, 200)
})

test('el equipo: solo los administradores lo gestionan y nadie se queda fuera por error', async () => {
  const { db } = await setup()
  const accounts = new Map<string, string>()
  const users = createUsers({ db, owners: ['dueno@pana.test'], identity: { create: async (email, password) => void accounts.set(email, password), remove: async (email) => void accounts.delete(email) } })
  assert.equal(await users.roleOf('dueno@pana.test'), 'admin')
  assert.equal(await users.roleOf('desconocida@pana.test'), null)

  // Sin contraseña se genera una fuerte, que solo se devuelve en ese momento.
  const made = await users.create({ email: ' Edita@Pana.test ', role: 'member' }, 'dueno@pana.test')
  assert.equal(made.email, 'edita@pana.test')
  assert.equal(made.password, accounts.get('edita@pana.test'))
  assert.ok(made.password!.length >= 20)
  assert.equal(await users.roleOf('edita@pana.test'), 'member')
  assert.equal((await users.create({ email: 'jefa@pana.test', role: 'admin', password: 'una-clave-larga' }, 'dueno@pana.test')).password, null)

  await assert.rejects(users.create({ email: 'edita@pana.test', role: 'member' }, 'dueno@pana.test'), /ya tiene acceso/)
  await assert.rejects(users.create({ email: 'sin-arroba', role: 'member' }, 'dueno@pana.test'), /correo válido/)
  await assert.rejects(users.create({ email: 'otra@pana.test', role: 'superadmin' }, 'dueno@pana.test'), /rol/)
  await assert.rejects(users.create({ email: 'otra@pana.test', role: 'member', password: 'corta' }, 'dueno@pana.test'), /10 caracteres/)
  await assert.rejects(users.remove('dueno@pana.test', 'jefa@pana.test'), /archivo \.env/)
  await assert.rejects(users.remove('jefa@pana.test', 'jefa@pana.test'), /ti mismo/)
  await assert.rejects(users.setRole('jefa@pana.test', 'member', 'jefa@pana.test'), /tu propio rol/)

  await users.setRole('edita@pana.test', 'admin', 'jefa@pana.test')
  assert.deepEqual((await users.list()).map((u) => [u.email, u.role, u.owner]), [['dueno@pana.test', 'admin', true], ['edita@pana.test', 'admin', false], ['jefa@pana.test', 'admin', false]])
  await users.remove('edita@pana.test', 'jefa@pana.test')
  assert.equal(await users.roleOf('edita@pana.test'), null)
  assert.equal(accounts.has('edita@pana.test'), false)

  // Por la API: un miembro no puede ni ver la lista.
  const { engine } = await setup()
  const app = createApp({ engine, users, publicConfig: { supabaseUrl: '', supabaseAnonKey: '' }, auth: async (t) => (t === 'admin' ? { email: 'jefa@pana.test', role: 'admin' } : t === 'miembro' ? { email: 'm@pana.test', role: 'member' } : null) })
  const get = (token: string, path: string) => app.request(path, { headers: { authorization: `Bearer ${token}` } })
  assert.equal((await get('miembro', '/api/admin/users')).status, 403)
  assert.equal((await get('miembro', '/api/admin/projects')).status, 403)
  assert.deepEqual(await (await get('miembro', '/api/me')).json(), { email: 'm@pana.test', role: 'member' })
  assert.equal((await (await get('admin', '/api/admin/users')).json()).length, 2)
})
