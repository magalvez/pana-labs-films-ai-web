import { PGlite } from '@electric-sql/pglite'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from './app.ts'
import { createEngine } from './engine/pipeline.ts'
import { createFinance, parseEntry } from './finance.ts'
import { migrate, type Exec } from './migrate.ts'
import { commercial } from './schemes/commercial.ts'
import { pgDb } from './store.ts'

// Mismo patrón que las pruebas del motor: Postgres embebido con las migraciones reales.
async function makeDb() {
  const pg = new PGlite()
  await pg.exec('create schema storage; create table storage.buckets (id text primary key, name text, public boolean)')
  const exec: Exec = async (text) => (await pg.exec(text)).at(-1)?.rows ?? []
  await migrate(exec)
  return pgDb(async (text, params) => (await pg.query(text, params)).rows)
}
async function setup() {
  const db = await makeDb()
  const finance = createFinance(db)
  // created_at en UTC: la de «Tarde» es el 1 de diciembre a las 02:00 UTC, o sea el 30 de noviembre en Colombia.
  const add = (id: string, name: string, brand: string | null, status: string, spent: number, created: string) =>
    db('INSERT INTO projects (id, name, brief, scheme, brand, status, budget_cap, spent, created_at) VALUES (?,?,?,?,?,?,?,?,?)', id, name, 'brief', 'commercial', brand, status, 100, spent, created)
  await add('a', 'Café', 'Aurora', 'done', 10, '2026-11-05T15:00:00.000Z')
  await add('b', 'Tenis', 'Volea', 'running', 4, '2026-12-01T02:00:00.000Z')
  await add('c', 'Octubre', 'Aurora', 'done', 6, '2026-10-10T15:00:00.000Z')
  return { db, finance }
}
const sale = (o: Record<string, unknown> = {}) => ({ amount: 100, currency: 'USD', fx: 4000, date: '2026-11-10', ...o })
const expense = (o: Record<string, unknown> = {}) => ({ description: 'Locutor', category: 'locucion', amount: 400_000, currency: 'COP', fx: 4000, date: '2026-11-12', ...o })

test('valida monto, moneda, fecha, tasa y categoría', () => {
  const today = new Date('2026-11-18T12:00:00Z')
  const bad = (body: Record<string, unknown>, kind: 'sale' | 'expense', re: RegExp) => assert.throws(() => parseEntry(body, kind, today), re)
  assert.deepEqual(parseEntry(sale({ amount: '12.345' }), 'sale', today), { currency: 'USD', amount: 12.35, fx: 4000, date: '2026-11-10', description: '', category: null })
  bad(sale({ amount: 0 }), 'sale', /mayor que cero/)
  bad(sale({ amount: -5 }), 'sale', /mayor que cero/)
  bad(sale({ amount: 'abc' }), 'sale', /mayor que cero/)
  bad(sale({ amount: null }), 'sale', /mayor que cero/)
  bad(sale({ amount: 1_000_001 }), 'sale', /no puede pasar/)
  bad(expense({ amount: 4_000_000_001 }), 'expense', /no puede pasar/)
  bad(sale({ currency: 'EUR' }), 'sale', /moneda/)
  bad(sale({ currency: undefined }), 'sale', /moneda/)
  bad(sale({ fx: 0 }), 'sale', /tasa/)
  bad(sale({ fx: 40 }), 'sale', /tasa/)
  bad(sale({ fx: undefined }), 'sale', /tasa/)
  bad(sale({ date: '2026-02-30' }), 'sale', /fecha/)
  bad(sale({ date: '10/11/2026' }), 'sale', /fecha/)
  bad(sale({ date: '2019-12-31' }), 'sale', /fuera de rango/)
  bad(sale({ date: '2028-01-01' }), 'sale', /fuera de rango/)
  bad(expense({ description: '  ' }), 'expense', /Describe/)
  bad(expense({ category: 'comida' }), 'expense', /categoría/)
  assert.equal(parseEntry(expense({ category: undefined }), 'expense', today).category, 'otros')
})

test('convierte entre monedas con la tasa de cada registro y recuerda la última', async () => {
  const { finance } = await setup()
  assert.equal(await finance.lastRate(), null)
  const usd = await finance.create('a', 'sale', sale({ amount: 200, currency: 'USD', fx: 4100 }), 'jefa')
  const cop = await finance.create('a', 'sale', sale({ amount: 2_000_000, currency: 'COP', fx: 4000 }), 'jefa')
  assert.deepEqual([usd.usd, usd.cop], [200, 820_000])
  assert.deepEqual([cop.usd, cop.cop], [500, 2_000_000])
  assert.equal(await finance.lastRate(), 4000)
  const edited = await finance.update(usd.id, sale({ amount: 300, currency: 'USD', fx: 4200 }))
  // Corregir un registro viejo no cambia la tasa que se propone para los nuevos.
  assert.deepEqual([edited.usd, edited.cop, await finance.lastRate()], [300, 1_260_000, 4000])
  await assert.rejects(finance.create('nada', 'sale', sale(), 'x'), /no existe/)
  await assert.rejects(finance.update('nada', sale()), /no existe/)
  await assert.rejects(finance.remove('nada'), /no existe/)
})

test('la rentabilidad de una producción resta IA y gastos de las ventas, con margen', async () => {
  const { finance } = await setup()
  await finance.create('a', 'sale', sale({ amount: 100, currency: 'USD', fx: 4000 }), 'jefa')
  await finance.create('a', 'sale', sale({ amount: 800_000, currency: 'COP', fx: 4000, date: '2026-12-02' }), 'jefa') // 200 USD
  await finance.create('a', 'expense', expense(), 'jefa') // 100 USD
  const { summary, entries } = await finance.forProject('a')
  assert.equal(entries.length, 3)
  assert.equal(summary.salesUsd, 300)
  assert.equal(summary.aiUsd, 10)
  assert.equal(summary.extraUsd, 100)
  assert.equal(summary.profitUsd, 190)
  assert.equal(summary.marginPct, 63.3)
  // En pesos: ventas 1.200.000 − IA 10 USD a la tasa del último registro (4000) − gasto 400.000.
  assert.deepEqual([summary.salesCop, summary.aiCop, summary.extraCop, summary.profitCop], [1_200_000, 40_000, 400_000, 760_000])
  // Sin ventas no hay margen que calcular.
  assert.equal((await finance.forProject('c')).summary.marginPct, null)
})

test('el filtro por fechas mete el gasto de IA el día de creación (hora de Colombia) y lo demás en su fecha', async () => {
  const { finance } = await setup()
  await finance.create('a', 'sale', sale({ amount: 100, date: '2026-11-10' }), 'x')
  await finance.create('a', 'expense', expense({ date: '2026-12-05' }), 'x') // 100 USD en diciembre
  await finance.create('c', 'sale', sale({ amount: 50, date: '2026-11-03' }), 'x') // producción de octubre, cobro en noviembre
  const nov = await finance.report({ month: '2026-11' })
  // «Tarde» (b) se creó el 30 de noviembre en Colombia, así que su IA cuenta en noviembre.
  assert.deepEqual(nov.projects.map((p) => p.id).sort(), ['a', 'b', 'c'])
  const byId = Object.fromEntries(nov.projects.map((p) => [p.id, p]))
  assert.deepEqual([byId.a.aiUsd, byId.a.salesUsd, byId.a.extraUsd], [10, 100, 0])
  assert.deepEqual([byId.b.aiUsd, byId.c.aiUsd, byId.c.salesUsd], [4, 0, 50])
  assert.deepEqual([nov.totals.aiUsd, nov.totals.salesUsd, nov.totals.extraUsd], [14, 150, 0])
  // Diciembre: solo el gasto de a.
  const dec = await finance.report({ from: '2026-12-01', to: '2026-12-31' })
  assert.deepEqual(dec.projects.map((p) => p.id), ['a'])
  assert.deepEqual([dec.totals.aiUsd, dec.totals.salesUsd, dec.totals.extraUsd, dec.totals.profitUsd], [0, 0, 100, -100])
  // Rango inclusivo en ambos extremos.
  assert.equal((await finance.report({ from: '2026-11-10', to: '2026-11-10' })).totals.salesUsd, 100)
  // Rango vacío, y rangos mal escritos.
  assert.deepEqual((await finance.report({ from: '2025-01-01', to: '2025-01-31' })).projects, [])
  await assert.rejects(finance.report({ month: '2026-13' }), /AAAA-MM/)
  await assert.rejects(finance.report({ from: '2026-12-01', to: '2026-11-01' }), /posterior/)
  await assert.rejects(finance.report({ from: 'ayer' }), /AAAA-MM-DD/)
})

test('filtra por cliente y por estado', async () => {
  const { finance } = await setup()
  assert.deepEqual((await finance.report({ brand: 'Aurora' })).projects.map((p) => p.id).sort(), ['a', 'c'])
  assert.deepEqual((await finance.report({ status: 'running' })).projects.map((p) => p.id), ['b'])
  assert.deepEqual((await finance.report({ brand: 'Aurora', status: 'running' })).projects, [])
  assert.deepEqual((await finance.report({})).brands, ['Aurora', 'Volea'])
})

test('el informe cuadra: totales = suma de producciones = suma de meses', async () => {
  const { finance } = await setup()
  await finance.create('a', 'sale', sale({ amount: 333.33, date: '2026-11-10' }), 'x')
  await finance.create('a', 'sale', sale({ amount: 1_500_000, currency: 'COP', fx: 3900, date: '2026-12-10' }), 'x')
  await finance.create('b', 'expense', expense({ amount: 77.77, currency: 'USD', date: '2026-12-11' }), 'x')
  await finance.create('c', 'sale', sale({ amount: 999, date: '2026-10-30' }), 'x')
  for (const f of [{}, { from: '2026-11-01' }, { to: '2026-11-30' }, { brand: 'Aurora' }]) {
    const r = await finance.report(f)
    const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 0.05, `${a} != ${b}`)
    for (const k of ['salesUsd', 'salesCop', 'aiUsd', 'aiCop', 'extraUsd', 'extraCop', 'costUsd', 'costCop', 'profitUsd', 'profitCop'] as const) {
      near(r.totals[k], r.projects.reduce((s, p) => s + p[k], 0))
      near(r.totals[k], r.months.reduce((s, m) => s + m[k], 0))
    }
    near(r.totals.profitUsd, r.totals.salesUsd - r.totals.costUsd)
    near(r.totals.profitCop, r.totals.salesCop - r.totals.costCop)
  }
  const all = await finance.report({})
  assert.deepEqual(all.months.map((m) => m.month), ['2026-10', '2026-11', '2026-12'])
})

test('la API de rentabilidad es solo para administradores y valida en el servidor', async () => {
  const { finance } = await setup()
  const app = createApp({ engine: {} as any, finance, publicConfig: { supabaseUrl: '', supabaseAnonKey: '' }, auth: async (t) => (t === 'admin' ? { email: 'jefa@pana.test', role: 'admin' } : t === 'miembro' ? { email: 'm@pana.test', role: 'member' } : null) })
  const as = (token: string, path: string, method = 'GET', body?: unknown) => app.request(path, { method, body: body ? JSON.stringify(body) : undefined, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
  assert.equal((await as('miembro', '/api/admin/finance/report')).status, 403)
  assert.equal((await as('miembro', '/api/admin/finance/projects/a/sales', 'POST', sale())).status, 403)
  assert.equal((await app.request('/api/admin/finance/report')).status, 401)

  assert.equal((await as('admin', '/api/admin/finance/projects/a/sales', 'POST', sale({ amount: -1 }))).status, 400)
  const made = await as('admin', '/api/admin/finance/projects/a/sales', 'POST', sale({ amount: 250 }))
  assert.equal(made.status, 201)
  const { id } = await made.json()
  assert.equal((await as('admin', '/api/admin/finance/projects/a/expenses', 'POST', { ...expense(), description: '' })).status, 400)
  assert.equal((await as('admin', `/api/admin/finance/entries/${id}`, 'PUT', sale({ amount: 300 }))).status, 200)
  const view = await (await as('admin', '/api/admin/finance/projects/a')).json()
  assert.deepEqual([view.entries.length, view.summary.salesUsd, view.rate], [1, 300, 4000])
  assert.equal((await (await as('admin', '/api/admin/finance/report?month=2026-11&brand=Aurora')).json()).totals.salesUsd, 300)
  assert.equal((await as('admin', '/api/admin/finance/report?month=nov')).status, 400)
  assert.equal((await as('admin', `/api/admin/finance/entries/${id}`, 'DELETE')).status, 200)
  assert.equal((await as('admin', `/api/admin/finance/entries/${id}`, 'DELETE')).status, 400)
})

test('borrar una producción borra también sus ventas y gastos', async () => {
  const { db, finance } = await setup()
  const engine = createEngine({ db, files: { removeDir: async () => {} } as any, schemes: { commercial }, runner: {} as any, explorer: {} as any })
  await finance.create('c', 'sale', sale(), 'x')
  await finance.create('a', 'sale', sale(), 'x')
  await engine.deleteProject('c')
  assert.deepEqual((await db('SELECT DISTINCT project_id FROM finance_entries')).map((r) => r.project_id), ['a'])
})
