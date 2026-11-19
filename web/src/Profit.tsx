import { useEffect, useMemo, useState } from 'react'
import { api } from './api'
import './profit.css'

type Act = (fn: () => Promise<unknown>) => Promise<boolean>
type Cur = 'USD' | 'COP'
type Fig = { salesUsd: number; salesCop: number; aiUsd: number; aiCop: number; extraUsd: number; extraCop: number; costUsd: number; costCop: number; profitUsd: number; profitCop: number; marginPct: number | null }
type Line = Fig & { id: string; name: string; brand: string | null; status: string; createdAt: string; entries: number; rate: number | null }
type Month = Fig & { month: string }
type Report = { rate: number | null; brands: string[]; totals: Fig; projects: Line[]; months: Month[] }
type Entry = { id: string; kind: 'sale' | 'expense'; category: string | null; description: string; amount: number; currency: Cur; fx: number; date: string; usd: number; cop: number }

const STATUS: Record<string, string> = { exploring: 'Explorando', running: 'En marcha', paused: 'En pausa', waiting_human: 'Espera decisión', done: 'Entregado', failed: 'Detenido', cancelled: 'Cancelado' }
const CATEGORY: Record<string, string> = { locucion: 'Locución humana', licencias: 'Licencias', equipo: 'Horas del equipo', otros: 'Otros' }

// Las cifras negativas llevan siempre el signo «−» delante, además del color y de la palabra «pérdida».
const nf = { USD: new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), COP: new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }) }
const money = (n: number, c: Cur) => `${n < 0 ? '−' : ''}${c === 'USD' ? 'US$ ' : 'COP '}${nf[c].format(Math.abs(n))}`
const pct = (n: number | null) => (n === null ? '—' : `${n < 0 ? '−' : ''}${Math.abs(n).toFixed(1).replace('.', ',')} %`)
const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' })
const monthName = (m: string) => new Date(`${m}-01T12:00:00`).toLocaleDateString('es', { month: 'short', year: 'numeric' })
const today = () => new Date().toLocaleDateString('en-CA')

/** Una cifra en dólares con su equivalente en pesos debajo. Sin tasa conocida, los pesos no se inventan. */
function Both({ usd, cop, rate, strong }: { usd: number; cop: number; rate: number | null; strong?: boolean }) {
  return <span className={`both${usd < 0 ? ' neg' : ''}`}>{strong ? <strong>{money(usd, 'USD')}</strong> : money(usd, 'USD')}<small>{rate === null ? 'COP sin tasa aún' : money(cop, 'COP')}</small></span>
}

// ---------------------------------------------------------------- Pantalla «Rentabilidad»

type SortKey = 'name' | 'createdAt' | 'salesUsd' | 'aiUsd' | 'extraUsd' | 'profitUsd' | 'marginPct'

/** Escapa una celda de CSV. Lo que empieza como fórmula se neutraliza: Excel ejecutaría un nombre que empiece por «=». */
const cell = (v: string | number | null) => {
  const formula = typeof v === 'string' && /^[=+\-@]/.test(v)
  const s = v === null ? '' : formula ? `'${v}` : String(v)
  return /[",\n]/.test(s) || formula ? `"${s.replaceAll('"', '""')}"` : s
}

/** Rentabilidad: lo vendido menos el gasto de IA y los gastos adicionales, por producción y por mes. */
export function Profit({ act }: { act: Act }) {
  const [report, setReport] = useState<Report | null>(null)
  const [mode, setMode] = useState<'all' | 'month' | 'range'>('all')
  const [month, setMonth] = useState(today().slice(0, 7))
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [brand, setBrand] = useState('')
  const [status, setStatus] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'createdAt', dir: -1 })

  const query = new URLSearchParams()
  if (mode === 'month' && month) query.set('month', month)
  if (mode === 'range') { if (from) query.set('from', from); if (to) query.set('to', to) }
  if (brand) query.set('brand', brand)
  if (status) query.set('status', status)
  const qs = query.toString()
  useEffect(() => {
    let gone = false
    void act(async () => { const r = await api<Report>(`/admin/finance/report?${qs}`); if (!gone) setReport(r) })
    return () => { gone = true }
  }, [qs])

  const rows = useMemo(() => {
    const out = [...(report?.projects ?? [])]
    const val = (r: Line) => (sort.key === 'name' ? r.name.toLowerCase() : sort.key === 'createdAt' ? r.createdAt : r[sort.key] ?? -Infinity)
    return out.sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * sort.dir)
  }, [report, sort])

  if (!report) return <div className="backlot"><p className="boot">Haciendo cuentas…</p></div>
  const t = report.totals
  const rate = report.rate
  const maxBar = Math.max(...report.months.flatMap((m) => [m.salesUsd, m.costUsd]), 0.01)
  const th = (key: SortKey, label: string, cls = '') => (
    <th scope="col" className={cls} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button className="sort" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (-s.dir as 1 | -1) : key === 'name' ? 1 : -1 }))}>{label}<span aria-hidden="true">{sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</span></button>
    </th>
  )

  const exportCsv = () => {
    const head = ['Producción', 'Cliente', 'Estado', 'Creada', 'Ventas USD', 'Ventas COP', 'Costo de IA USD', 'Costo de IA COP', 'Gastos adicionales USD', 'Gastos adicionales COP', 'Ganancia USD', 'Ganancia COP', 'Margen %']
    const lines = rows.map((r) => [r.name, r.brand ?? '', STATUS[r.status] ?? r.status, r.createdAt.slice(0, 10), r.salesUsd, r.salesCop, r.aiUsd, r.aiCop, r.extraUsd, r.extraCop, r.profitUsd, r.profitCop, r.marginPct])
    // El BOM hace que Excel lea bien las tildes.
    const blob = new Blob(['﻿' + [head, ...lines].map((l) => l.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `rentabilidad-${today()}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  }

  const cards: { label: string; fig: [number, number]; sub?: string; neg?: boolean }[] = [
    { label: 'Vendido', fig: [t.salesUsd, t.salesCop] },
    { label: 'Costo de IA', fig: [t.aiUsd, t.aiCop], sub: 'agentes y generación' },
    { label: 'Gastos adicionales', fig: [t.extraUsd, t.extraCop], sub: 'locución, licencias, equipo…' },
    { label: t.profitUsd < 0 ? 'Pérdida' : 'Ganancia', fig: [t.profitUsd, t.profitCop], neg: t.profitUsd < 0 },
  ]

  return (
    <div className="backlot profit">
      <header className="backlot-head">
        <h2>Rentabilidad</h2>
        <p>Lo vendido menos el gasto de IA y los gastos adicionales de cada producción. Las ventas y los gastos se registran en la hoja de cada producción.</p>
      </header>

      <div className="filters">
        <label>Periodo<select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="all">Todo el tiempo</option><option value="month">Un mes</option><option value="range">Fechas concretas</option></select></label>
        {mode === 'month' && <label>Mes<input type="month" value={month} placeholder="AAAA-MM" pattern="[0-9]{4}-[0-9]{2}" onChange={(e) => setMonth(e.target.value)} /></label>}
        {mode === 'range' && <><label>Desde<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label>Hasta<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label></>}
        <label>Cliente<select value={brand} onChange={(e) => setBrand(e.target.value)}><option value="">Todos</option>{report.brands.map((b) => <option key={b}>{b}</option>)}</select></label>
        <label>Estado<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todos</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <button className="export" disabled={!rows.length} onClick={exportCsv}>Exportar CSV</button>
      </div>
      <p className="pf-rule">Con fechas, el gasto de IA cuenta el día en que se creó la producción (hora de Colombia). Las ventas y los gastos adicionales cuentan en su propia fecha. Los pesos usan la tasa de cada registro; el gasto de IA, la del último registro de su producción.</p>

      <dl className="marcador pf-cards">
        {cards.map((c) => (
          <div key={c.label} className={c.neg ? 'neg' : ''}>
            <dt>{c.label}</dt>
            <dd>{money(c.fig[0], 'USD')}</dd>
            <dd className="sub">{rate === null ? 'COP: aún no hay una tasa de cambio' : money(c.fig[1], 'COP')}</dd>
            {c.sub && <dd className="sub">{c.sub}</dd>}
          </div>
        ))}
        <div className={t.profitUsd < 0 ? 'neg' : ''}>
          <dt>Margen</dt>
          <dd>{pct(t.marginPct)}</dd>
          <dd className="sub">{t.marginPct === null ? 'sin ventas en este periodo' : t.profitUsd < 0 ? 'pérdida sobre lo vendido' : 'ganancia sobre lo vendido'}</dd>
        </div>
      </dl>

      {!rows.length ? (
        <section className="pf-panel pf-empty" aria-live="polite">
          <h3>Nada que mostrar</h3>
          <p>{report.projects.length === 0 && !qs ? 'Todavía no hay producciones. Cuando haya una, registra su venta y sus gastos adicionales desde Producciones.' : 'Ninguna producción tiene movimientos con estos filtros. Prueba con otro periodo o quita el cliente o el estado.'}</p>
        </section>
      ) : (
        <>
          <section className="pf-panel" aria-label="Rentabilidad por mes">
            <h3>Por mes</h3>
            <p className="legend"><span className="pf-key sold" />Vendido<span className="pf-key cost" />Costo (IA y gastos adicionales)</p>
            <table className="pf-months">
              <thead><tr><th scope="col">Mes</th><th scope="col"><span className="sr">Barras</span></th><th scope="col" className="num">Ganancia</th><th scope="col" className="num">Margen</th></tr></thead>
              <tbody>{report.months.map((m, i) => (
                <tr key={m.month} style={{ '--i': i } as React.CSSProperties}>
                  <th scope="row">{monthName(m.month)}</th>
                  <td className="bars">
                    <span className="bar-line"><span className="pf-bar sold" style={{ width: `${(m.salesUsd / maxBar) * 100}%` }} /><b>{money(m.salesUsd, 'USD')}</b></span>
                    <span className="bar-line"><span className="pf-bar cost" style={{ width: `${(m.costUsd / maxBar) * 100}%` }} /><b>{money(m.costUsd, 'USD')}</b></span>
                  </td>
                  <td className={`num${m.profitUsd < 0 ? ' neg' : ''}`}><Both usd={m.profitUsd} cop={m.profitCop} rate={rate} />{m.profitUsd < 0 && <small className="loss">pérdida</small>}</td>
                  <td className={`num${m.profitUsd < 0 ? ' neg' : ''}`}>{pct(m.marginPct)}</td>
                </tr>
              ))}</tbody>
            </table>
          </section>

          <section className="pf-panel" aria-label="Rentabilidad por producción">
            <h3>Por producción</h3>
            <table className="pf-table">
              <thead><tr>{th('name', 'Producción')}{th('salesUsd', 'Vendido', 'num')}{th('aiUsd', 'Costo de IA', 'num')}{th('extraUsd', 'Gastos adicionales', 'num')}{th('profitUsd', 'Ganancia', 'num')}{th('marginPct', 'Margen', 'num')}</tr></thead>
              <tbody>{rows.map((r, i) => (
                <tr key={r.id} style={{ '--i': i } as React.CSSProperties}>
                  <th scope="row" data-label="Producción">{r.name}<small>{r.brand ?? 'Sin cliente'}, {STATUS[r.status] ?? r.status}, creada el {day(r.createdAt.slice(0, 10))}</small></th>
                  <td className="num" data-label="Vendido"><Both usd={r.salesUsd} cop={r.salesCop} rate={rate} /></td>
                  <td className="num" data-label="Costo de IA"><Both usd={r.aiUsd} cop={r.aiCop} rate={rate} /></td>
                  <td className="num" data-label="Gastos adicionales"><Both usd={r.extraUsd} cop={r.extraCop} rate={rate} /></td>
                  <td className={`num${r.profitUsd < 0 ? ' neg' : ''}`} data-label={r.profitUsd < 0 ? 'Pérdida' : 'Ganancia'}><Both usd={r.profitUsd} cop={r.profitCop} rate={rate} strong />{r.profitUsd < 0 && <small className="loss">pérdida</small>}</td>
                  <td className={`num${r.profitUsd < 0 ? ' neg' : ''}`} data-label="Margen">{pct(r.marginPct)}</td>
                </tr>
              ))}</tbody>
              <tfoot><tr>
                <th scope="row" data-label="Total">Total de {rows.length} producci{rows.length === 1 ? 'ón' : 'ones'}</th>
                <td className="num" data-label="Vendido"><Both usd={t.salesUsd} cop={t.salesCop} rate={rate} /></td>
                <td className="num" data-label="Costo de IA"><Both usd={t.aiUsd} cop={t.aiCop} rate={rate} /></td>
                <td className="num" data-label="Gastos adicionales"><Both usd={t.extraUsd} cop={t.extraCop} rate={rate} /></td>
                <td className={`num${t.profitUsd < 0 ? ' neg' : ''}`} data-label={t.profitUsd < 0 ? 'Pérdida' : 'Ganancia'}><Both usd={t.profitUsd} cop={t.profitCop} rate={rate} strong />{t.profitUsd < 0 && <small className="loss">pérdida</small>}</td>
                <td className={`num${t.profitUsd < 0 ? ' neg' : ''}`} data-label="Margen">{pct(t.marginPct)}</td>
              </tr></tfoot>
            </table>
          </section>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- Sección dentro de la hoja de cada producción

type Form = { id: string | null; kind: 'sale' | 'expense'; description: string; category: string; amount: string; currency: Cur; fx: string; date: string }
const blank = (fx: number | null): Form => ({ id: null, kind: 'sale', description: '', category: 'otros', amount: '', currency: 'USD', fx: fx ? String(fx) : '', date: today() })

/** Ventas y gastos adicionales de una producción, con su mini resumen. Va dentro de la hoja de Producciones. */
export function SheetFinance({ id, spent, act }: { id: string; spent: number; act: Act }) {
  const [data, setData] = useState<{ entries: Entry[]; rate: number | null; summary: Line } | null>(null)
  const [form, setForm] = useState<Form>(blank(null))
  const [asking, setAsking] = useState<string | null>(null)
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))

  const load = () => act(async () => {
    const d = await api<NonNullable<typeof data>>(`/admin/finance/projects/${id}`)
    setData(d)
    // La tasa que se propone es la última usada; si la persona ya escribió una, se respeta.
    setForm((f) => (f.fx || f.id ? f : { ...f, fx: d.rate ? String(d.rate) : '' }))
  })
  useEffect(() => { setForm(blank(null)); setData(null); void load() }, [id])
  useEffect(() => { if (data) void load() }, [spent])

  const save = () => act(async () => {
    const body = { description: form.description, category: form.kind === 'expense' ? form.category : undefined, amount: Number(form.amount), currency: form.currency, fx: Number(form.fx), date: form.date }
    await api(form.id ? `/admin/finance/entries/${form.id}` : `/admin/finance/projects/${id}/${form.kind === 'sale' ? 'sales' : 'expenses'}`, form.id ? 'PUT' : 'POST', body)
    setForm({ ...blank(Number(form.fx)), kind: form.kind, category: form.category, currency: form.currency, date: form.date })
    await load()
  })

  const s = data?.summary
  const rate = data?.rate ?? null
  const edit = (e: Entry) => { setForm({ id: e.id, kind: e.kind, description: e.description, category: e.category ?? 'otros', amount: String(e.amount), currency: e.currency, fx: String(e.fx), date: e.date }); document.getElementById(`pf-form-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }

  return (
    <section className="pf-sheet" aria-label="Ventas y gastos adicionales">
      <h4>Ventas y gastos adicionales</h4>
      <p className="note">Ganancia = ventas − gasto de IA ({money(spent, 'USD')}) − gastos adicionales. Cada registro guarda su moneda y la tasa de cambio de su día.</p>
      {!s ? <p className="hint">Sumando…</p> : (
        <>
          <dl className="facts pf-mini">
            <div><dt>Vendido</dt><dd><Both usd={s.salesUsd} cop={s.salesCop} rate={rate} /></dd></div>
            <div><dt>Costo total</dt><dd><Both usd={s.costUsd} cop={s.costCop} rate={rate} /></dd><dd className="sub">IA {money(s.aiUsd, 'USD')} más adicionales {money(s.extraUsd, 'USD')}</dd></div>
            <div className={s.profitUsd < 0 ? 'neg' : ''}><dt>{s.profitUsd < 0 ? 'Pérdida' : 'Ganancia'}</dt><dd><Both usd={s.profitUsd} cop={s.profitCop} rate={rate} /></dd></div>
            <div className={s.profitUsd < 0 ? 'neg' : ''}><dt>Margen</dt><dd>{pct(s.marginPct)}</dd>{s.marginPct === null && <dd className="sub">sin ventas todavía</dd>}</div>
          </dl>

          {data!.entries.length > 0 && (
            <table className="plain pf-entries">
              <thead><tr><th scope="col">Fecha</th><th scope="col">Qué</th><th scope="col" className="num">Monto</th><th scope="col" className="num">Tasa</th><th scope="col"><span className="sr">Acciones</span></th></tr></thead>
              <tbody>{data!.entries.map((e) => (
                <tr key={e.id}>
                  <td>{day(e.date)}</td>
                  <th scope="row">{e.kind === 'sale' ? 'Venta' : CATEGORY[e.category ?? 'otros']}<small>{e.description || (e.kind === 'sale' ? 'Cobro' : '')}</small></th>
                  <td className="num"><span className="both">{e.kind === 'expense' ? '−' : ''}{money(e.amount, e.currency)}<small>{money(e.currency === 'USD' ? e.cop : e.usd, e.currency === 'USD' ? 'COP' : 'USD')}</small></span></td>
                  <td className="num">{nf.COP.format(e.fx)}</td>
                  <td className="num acts">
                    {asking === e.id
                      ? <><button className="danger" onClick={() => act(async () => { await api(`/admin/finance/entries/${e.id}`, 'DELETE'); setAsking(null); await load() })}>Borrar</button><button onClick={() => setAsking(null)}>No</button></>
                      : <><button className="quiet" onClick={() => edit(e)}>Editar</button><button className="quiet" onClick={() => setAsking(e.id)}>Borrar</button></>}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          )}

          <form id={`pf-form-${id}`} className="pf-form" onSubmit={(e) => { e.preventDefault(); void save() }}>
            <fieldset className="kind" disabled={!!form.id}>
              <legend>{form.id ? 'Editar el registro' : 'Nuevo registro'}</legend>
              {(['sale', 'expense'] as const).map((k) => <label key={k} className="pick"><input type="radio" name={`kind-${id}`} checked={form.kind === k} onChange={() => set({ kind: k })} />{k === 'sale' ? 'Venta (cobro)' : 'Gasto adicional'}</label>)}
            </fieldset>
            <label className="wide">{form.kind === 'sale' ? 'Nota (opcional)' : 'Descripción'}<input value={form.description} maxLength={200} required={form.kind === 'expense'} onChange={(e) => set({ description: e.target.value })} placeholder={form.kind === 'sale' ? 'Anticipo, saldo, factura 123…' : 'Locutor, licencia de música…'} /></label>
            {form.kind === 'expense' && <label>Categoría<select value={form.category} onChange={(e) => set({ category: e.target.value })}>{Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>}
            <label>Monto<input type="number" inputMode="decimal" min="0.01" step="any" required value={form.amount} onChange={(e) => set({ amount: e.target.value })} /></label>
            <label>Moneda<select value={form.currency} onChange={(e) => set({ currency: e.target.value as Cur })}><option value="USD">Dólares (USD)</option><option value="COP">Pesos (COP)</option></select></label>
            <label>Tasa de ese día (COP por USD)<input type="number" inputMode="decimal" min="500" max="20000" step="any" required value={form.fx} onChange={(e) => set({ fx: e.target.value })} placeholder="Ej. 4000" /></label>
            <label>Fecha<input type="date" required value={form.date} onChange={(e) => set({ date: e.target.value })} /></label>
            <div className="pf-actions">
              <button className="primary">{form.id ? 'Guardar cambios' : form.kind === 'sale' ? 'Registrar la venta' : 'Registrar el gasto'}</button>
              {form.id && <button type="button" onClick={() => setForm(blank(Number(form.fx)))}>Cancelar</button>}
              {Number(form.amount) > 0 && Number(form.fx) > 0 && <span className="note">Equivale a {form.currency === 'USD' ? money(Number(form.amount) * Number(form.fx), 'COP') : money(Number(form.amount) / Number(form.fx), 'USD')}</span>}
            </div>
          </form>
        </>
      )}
    </section>
  )
}
