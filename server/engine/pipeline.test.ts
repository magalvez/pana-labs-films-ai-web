import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openDb } from '../db.ts'
import { commercial } from '../schemes/commercial.ts'
import { createEngine } from './pipeline.ts'
import { simRunner } from './simRunner.ts'
import type { Runner } from './types.ts'

const AGENTS = commercial.stages.flatMap((s) => s.agents).length

function setup(runner: Runner = simRunner(), db = openDb(':memory:'), workspace = mkdtempSync(join(tmpdir(), 'pfl-'))) {
  const engine = createEngine({ db, workspace, schemes: { commercial }, runner })
  return { engine, db, workspace }
}

async function start(engine: ReturnType<typeof setup>['engine'], budgetCap = 100) {
  const { id } = engine.createProject({ name: 'Prueba', brief: 'Comercial de 15 s', budgetCap })
  await engine.advance(id)
  return id
}

test('sin revisión humana, un proyecto recorre las 5 etapas', async () => {
  const { engine } = setup()
  engine.setSettings({ humanReview: false })
  const p = engine.getProject(await start(engine))
  assert.equal(p.status, 'done')
  assert.equal(p.steps.length, AGENTS)
  assert.deepEqual(p.stages.map((s) => s.status), Array(5).fill('approved'))
})

test('un rechazo del auditor relanza solo al agente señalado', async () => {
  const { engine } = setup(simRunner({ rejectOnce: ['production'] }))
  engine.setSettings({ humanReview: false })
  const p = engine.getProject(await start(engine))
  assert.equal(p.status, 'done')
  const redone = p.steps.filter((s) => s.version > 1)
  assert.deepEqual(redone.map((s) => `${s.agent} v${s.version}`), ['cinematography v2'])
  assert.equal(p.steps.find((s) => s.agent === 'cinematography' && s.version === 1)?.status, 'rejected')
})

test('con revisión humana el gate pausa; aprobar avanza y rechazar devuelve el trabajo', async () => {
  const { engine } = setup()
  const id = await start(engine)
  assert.deepEqual([engine.getProject(id).status, engine.getProject(id).reason, engine.getProject(id).currentStage], ['waiting_human', 'gate', 'strategy'])

  await engine.decide(id, { approve: true })
  assert.equal(engine.getProject(id).currentStage, 'preproduction')

  assert.throws(() => engine.decide(id, { approve: false }), /comentario/)
  await engine.decide(id, { approve: false, comment: 'El storyboard no cierra con el producto', agents: ['storyboard-previs'] })
  const p = engine.getProject(id)
  assert.deepEqual([p.status, p.currentStage], ['waiting_human', 'preproduction'])
  assert.deepEqual(p.steps.filter((s) => s.version === 2).map((s) => s.agent), ['storyboard-previs'])
})

test('el tope de presupuesto detiene el motor y subirlo lo reanuda', async () => {
  const paid: Runner = { ...simRunner(), runAgent: async (run) => (await simRunner().runAgent(run), { costUsd: 1 }) }
  const { engine } = setup(paid)
  engine.setSettings({ humanReview: false })
  const id = await start(engine, 2.5)
  let p = engine.getProject(id)
  assert.deepEqual([p.status, p.reason, p.steps.length, p.spent], ['paused', 'budget', 3, 3])
  await engine.resume(id, 1000)
  p = engine.getProject(id)
  assert.deepEqual([p.status, p.spent], ['done', AGENTS])
})

test('tras reiniciar, el proyecto sigue desde el último paso completo', async () => {
  let calls = 0
  let crashed!: () => void
  const reached = new Promise<void>((r) => (crashed = r))
  const dying: Runner = { ...simRunner(), runAgent: (run) => (++calls === 6 ? (crashed(), new Promise(() => {})) : simRunner().runAgent(run)) }
  const { engine, db, workspace } = setup(dying)
  engine.setSettings({ humanReview: false })
  const { id } = engine.createProject({ name: 'Caída', brief: 'x', budgetCap: 100 })
  await reached

  let resumed = 0
  const counting: Runner = { ...simRunner(), runAgent: (run) => (resumed++, simRunner().runAgent(run)) }
  const second = setup(counting, db, workspace).engine
  await second.resumeAll()
  assert.equal(second.getProject(id).status, 'done')
  assert.equal(resumed, AGENTS - 5)
})

test('un traspaso incompleto se relanza sin llegar al auditor', async () => {
  let first = true
  const sloppy: Runner = { ...simRunner(), runAgent: async (run) => (first ? ((first = false), { costUsd: 0 }) : simRunner().runAgent(run)) }
  const { engine } = setup(sloppy)
  engine.setSettings({ humanReview: false })
  const id = await start(engine)
  assert.equal(engine.getProject(id).status, 'done')
  const types = engine.eventsAfter(id).map((e) => e.type)
  assert.equal(types.filter((t) => t === 'contract.failed').length, 1)
  assert.ok(types.indexOf('contract.failed') < types.indexOf('audit.started'))
})

test('tras 2 reintentos el auditor escala a una persona aunque la revisión humana esté apagada', async () => {
  const strict: Runner = { ...simRunner(), runAuditor: async ({ stage }) => ({ approved: false, costUsd: 0, issues: [{ agent: stage.agents[0].id, problem: 'No cumple' }] }) }
  const { engine } = setup(strict)
  engine.setSettings({ humanReview: false })
  const id = await start(engine)
  const p = engine.getProject(id)
  assert.deepEqual([p.status, p.reason, p.currentStage], ['waiting_human', 'escalated', 'strategy'])
  assert.equal(p.steps.filter((s) => s.agent === 'brief-strategy').length, 3)
})

test('pausar y relanzar un agente con una nota', async () => {
  const { engine } = setup()
  const id = await start(engine)
  assert.throws(() => engine.pause(id), /en marcha/)
  await assert.rejects(engine.rerun(id, 'art-director', 'otra paleta'), /Pausa/)
})

test('cada agente y auditor del esquema tiene su archivo de instrucciones', () => {
  const ids = commercial.stages.flatMap((s) => [...s.agents.map((a) => a.id), s.auditor.id])
  const missing = ids.filter((id) => !existsSync(join(import.meta.dirname, '..', 'agents', `${id}.md`)))
  assert.deepEqual(missing, [])
  assert.equal(ids.length, 32)
})
