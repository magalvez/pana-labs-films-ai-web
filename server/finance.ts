/**
 * Rentabilidad por producción: ventas y gastos adicionales en USD o COP, y el informe que los junta con el gasto de IA.
 *
 * Rentabilidad = ventas − gasto de IA (projects.spent, en USD) − gastos adicionales. Margen = ganancia / ventas.
 *
 * Reglas que conviene tener claras:
 * - Cada registro lleva su moneda y la tasa COP por USD de su día. Un registro en USD se muestra en COP con su tasa, y al revés.
 * - El gasto de IA no tiene tasa propia: se pasa a COP con la tasa del último registro de esa producción
 *   o, si no tiene, con la última tasa usada en cualquier parte.
 * - En un filtro por fechas, el gasto de IA entra con el día de CREACIÓN de la producción (hora de Colombia);
 *   las ventas y los gastos entran con su propia fecha.
 * - El margen se calcula en dólares, para que no cambie según la tasa con que se pase a pesos.
 */
import type { Db } from './engine/types.ts'

export const CATEGORIES = ['locucion', 'licencias', 'equipo', 'otros'] as const
type Kind = 'sale' | 'expense'
type Currency = 'USD' | 'COP'
export type Entry = { id: string; projectId: string; kind: Kind; category: string | null; description: string; amount: number; currency: Currency; fx: number; date: string; createdBy: string; createdAt: string; usd: number; cop: number }

// Topes razonables por registro: evitan un cero de más al teclear.
const MAX_AMOUNT: Record<Currency, number> = { USD: 1_000_000, COP: 4_000_000_000 }
const FX_RANGE = [500, 20_000]
const RATE_KEY = 'fxCopPerUsd'

const r2 = (n: number) => Math.round(n * 100) / 100
const r1 = (n: number) => Math.round(n * 10) / 10
/** Colombia no cambia de hora: UTC−5 todo el año. */
const bogota = (ts: string) => new Date(Date.parse(ts) - 5 * 3600_000).toISOString().slice(0, 10)
const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s)

/** Valida y normaliza lo que llega del navegador. Lanza con un mensaje que se puede mostrar tal cual. */
export function parseEntry(body: Record<string, any>, kind: Kind, today = new Date()) {
  const currency: Currency = body.currency
  if (currency !== 'USD' && currency !== 'COP') throw new Error('La moneda debe ser USD o COP')
  const amount = typeof body.amount === 'number' || (typeof body.amount === 'string' && body.amount.trim() !== '') ? Number(body.amount) : NaN
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('El monto debe ser un número mayor que cero')
  if (amount > MAX_AMOUNT[currency]) throw new Error(`El monto no puede pasar de ${MAX_AMOUNT[currency].toLocaleString('es')} ${currency}`)
  const fx = typeof body.fx === 'number' || (typeof body.fx === 'string' && body.fx.trim() !== '') ? Number(body.fx) : NaN
  if (!Number.isFinite(fx) || fx < FX_RANGE[0] || fx > FX_RANGE[1]) throw new Error(`La tasa de cambio (COP por USD) debe estar entre ${FX_RANGE[0]} y ${FX_RANGE[1].toLocaleString('es')}`)
  if (!isDay(body.date)) throw new Error('La fecha debe ser un día válido con formato AAAA-MM-DD')
  const limit = new Date(today); limit.setUTCFullYear(limit.getUTCFullYear() + 1)
  if (body.date < '2020-01-01' || body.date > limit.toISOString().slice(0, 10)) throw new Error('La fecha está fuera de rango: entre 2020 y un año a futuro')
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 200) : ''
  if (kind === 'expense' && !description) throw new Error('Describe el gasto')
  const category = kind === 'sale' ? null : body.category === undefined || body.category === '' ? 'otros' : body.category
  if (kind === 'expense' && !CATEGORIES.includes(category)) throw new Error('Esa categoría no existe')
  return { currency: currency as Currency, amount: r2(amount), fx: r2(fx), date: body.date as string, description, category: category as string | null }
}

const entry = (r: any): Entry => {
  const amount = Number(r.amount), fx = Number(r.fx_cop_per_usd), usd = r.currency === 'USD'
  return { id: r.id, projectId: r.project_id, kind: r.kind, category: r.category, description: r.description, amount, currency: r.currency, fx, date: r.on_date, createdBy: r.created_by, createdAt: r.created_at, usd: usd ? amount : amount / fx, cop: usd ? amount * fx : amount }
}

type Atom = { projectId: string; month: string; part: 'sales' | 'ai' | 'extra'; usd: number; cop: number }

/** Suma átomos en las cifras de una tarjeta, una fila o un mes. */
function figures(atoms: Atom[]) {
  const sum = (part: Atom['part'], k: 'usd' | 'cop') => atoms.filter((a) => a.part === part).reduce((s, a) => s + a[k], 0)
  const [salesUsd, salesCop, aiUsd, aiCop, extraUsd, extraCop] = [sum('sales', 'usd'), sum('sales', 'cop'), sum('ai', 'usd'), sum('ai', 'cop'), sum('extra', 'usd'), sum('extra', 'cop')]
  const profitUsd = salesUsd - aiUsd - extraUsd
  return {
    salesUsd: r2(salesUsd), salesCop: r2(salesCop), aiUsd: r2(aiUsd), aiCop: r2(aiCop), extraUsd: r2(extraUsd), extraCop: r2(extraCop),
    costUsd: r2(aiUsd + extraUsd), costCop: r2(aiCop + extraCop), profitUsd: r2(profitUsd), profitCop: r2(salesCop - aiCop - extraCop),
    marginPct: salesUsd > 0 ? r1((profitUsd / salesUsd) * 100) : null,
  }
}

export type Filters = { from?: string; to?: string; month?: string; brand?: string; status?: string }

export function createFinance(db: Db) {
  async function lastRate(): Promise<number | null> {
    const [row] = await db('SELECT value FROM settings WHERE key = ?', RATE_KEY)
    return row ? Number(JSON.parse(row.value)) : null
  }
  const rememberRate = (fx: number) => db('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', RATE_KEY, JSON.stringify(fx))

  async function project(id: string) {
    const [p] = await db('SELECT id, name, brand, status, spent, created_at FROM projects WHERE id = ?', id)
    if (!p) throw new Error('Esa producción no existe')
    return p
  }

  /** Reparte en átomos (producción, mes, parte) lo que cuenta dentro del rango. Todo lo demás se suma desde aquí, así el informe cuadra. */
  /** `only`: una sola producción; entonces las consultas se limitan a ella en vez de recorrer todos los registros. */
  async function build(projects: any[], from = '0000-01-01', to = '9999-12-31', only?: string) {
    const fallback = await lastRate()
    const rates = new Map((await db(`SELECT DISTINCT ON (project_id) project_id, fx_cop_per_usd FROM finance_entries ${only ? 'WHERE project_id = ?' : ''} ORDER BY project_id, on_date DESC, created_at DESC`, ...(only ? [only] : []))).map((r) => [r.project_id as string, Number(r.fx_cop_per_usd)]))
    const ids = new Set(projects.map((p) => p.id))
    // ponytail: trae todos los registros del rango y filtra por producción en memoria; con decenas de miles de registros, filtrar en SQL.
    const entries = (await db(`SELECT * FROM finance_entries WHERE on_date >= ? AND on_date <= ?${only ? ' AND project_id = ?' : ''}`, from, to, ...(only ? [only] : []))).map(entry).filter((e) => ids.has(e.projectId))
    const atoms: Atom[] = []
    const inside = new Set<string>()
    for (const p of projects) {
      const created = bogota(p.created_at)
      if (created < from || created > to) continue
      inside.add(p.id)
      const spent = Number(p.spent)
      atoms.push({ projectId: p.id, month: created.slice(0, 7), part: 'ai', usd: spent, cop: spent * (rates.get(p.id) ?? fallback ?? 0) })
    }
    for (const e of entries) {
      inside.add(e.projectId)
      atoms.push({ projectId: e.projectId, month: e.date.slice(0, 7), part: e.kind === 'sale' ? 'sales' : 'extra', usd: e.usd, cop: e.cop })
    }
    const rows = projects.filter((p) => inside.has(p.id)).map((p) => {
      const mine = atoms.filter((a) => a.projectId === p.id)
      return { id: p.id, name: p.name, brand: p.brand, status: p.status, createdAt: p.created_at, entries: entries.filter((e) => e.projectId === p.id).length, rate: rates.get(p.id) ?? fallback, ...figures(mine) }
    })
    return { atoms, rows, rate: fallback }
  }

  /** Convierte el mes «2026-11» en 2026-11-01 … 2026-11-30 y valida las fechas del filtro. */
  function range(f: Filters) {
    let { from, to } = f
    if (f.month) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(f.month)) throw new Error('El mes debe tener formato AAAA-MM')
      from = `${f.month}-01`
      to = new Date(Date.UTC(Number(f.month.slice(0, 4)), Number(f.month.slice(5)), 0)).toISOString().slice(0, 10)
    }
    for (const d of [from, to]) if (d && !isDay(d)) throw new Error('Las fechas del filtro deben tener formato AAAA-MM-DD')
    if (from && to && from > to) throw new Error('La fecha inicial no puede ser posterior a la final')
    return { from: from || undefined, to: to || undefined }
  }

  return {
    lastRate,

    /** Los registros de una producción y su mini resumen (sin filtro de fechas). */
    async forProject(id: string) {
      const p = await project(id)
      const entries = (await db('SELECT * FROM finance_entries WHERE project_id = ? ORDER BY on_date DESC, created_at DESC', id)).map(entry)
      const { rows } = await build([p], undefined, undefined, id)
      return { entries, rate: await lastRate(), summary: rows[0] }
    },

    async create(projectId: string, kind: Kind, body: Record<string, any>, by: string) {
      await project(projectId)
      const v = parseEntry(body, kind)
      const id = crypto.randomUUID()
      await db('INSERT INTO finance_entries (id, project_id, kind, category, description, amount, currency, fx_cop_per_usd, on_date, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', id, projectId, kind, v.category, v.description, v.amount, v.currency, v.fx, v.date, by, new Date().toISOString())
      await rememberRate(v.fx)
      return entry((await db('SELECT * FROM finance_entries WHERE id = ?', id))[0])
    },

    /** Edita todo menos el tipo (venta o gasto) y la producción: para eso se borra y se crea de nuevo. */
    async update(id: string, body: Record<string, any>) {
      const [old] = await db('SELECT kind FROM finance_entries WHERE id = ?', id)
      if (!old) throw new Error('Ese registro no existe')
      const v = parseEntry(body, old.kind)
      await db('UPDATE finance_entries SET category = ?, description = ?, amount = ?, currency = ?, fx_cop_per_usd = ?, on_date = ?, updated_at = ? WHERE id = ?', v.category, v.description, v.amount, v.currency, v.fx, v.date, new Date().toISOString(), id)
      return entry((await db('SELECT * FROM finance_entries WHERE id = ?', id))[0])
    },

    async remove(id: string) {
      if (!(await db('DELETE FROM finance_entries WHERE id = ? RETURNING id', id)).length) throw new Error('Ese registro no existe')
    },

    /** El informe: totales, una fila por producción y un resumen por mes, con los filtros pedidos. */
    async report(f: Filters) {
      const { from, to } = range(f)
      const all = await db('SELECT id, name, brand, status, spent, created_at FROM projects ORDER BY created_at DESC')
      const projects = all.filter((p) => (!f.brand || p.brand === f.brand) && (!f.status || p.status === f.status))
      const { atoms, rows, rate } = await build(projects, from, to)
      const months = [...Map.groupBy(atoms, (a) => a.month)].sort(([a], [b]) => a.localeCompare(b)).map(([month, list]) => ({ month, ...figures(list) }))
      return {
        filters: { from: from ?? null, to: to ?? null, brand: f.brand || null, status: f.status || null },
        rate,
        brands: [...new Set(all.map((p) => p.brand).filter(Boolean))].sort() as string[],
        totals: figures(atoms), projects: rows, months,
      }
    },
  }
}
export type Finance = ReturnType<typeof createFinance>
