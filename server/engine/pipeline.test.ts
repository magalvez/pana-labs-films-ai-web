import { PGlite } from '@electric-sql/pglite'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { migrate, migrationStatus, type Exec } from '../migrate.ts'
import { commercial } from '../schemes/commercial.ts'
import { pgDb } from '../store.ts'
import { createEngine } from './pipeline.ts'
import { simRunner } from './simRunner.ts'
import type { Db, Files, Runner } from './types.ts'

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
  const store = new Map<string, string>()
  return {
read: async (path) => store.get(path) ?? null,
write: async (path, content) => void store.set(path, content),
removeDir: async (prefix) => { for (const key of store.keys()) if (key.startsWith(prefix + '/')) store.delete(key) },
  }
}
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
