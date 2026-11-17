/**
 * Migraciones SQL de la base de datos.
 *
 * Flujo de trabajo:
 *   1. Escribe la migración a mano: supabase/migrations/00NN_nombre.sql
 *      (idempotente siempre que se pueda: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
 *   2. npm run db:migrate          → aplica las pendientes en orden.
 *      npm run db:migrate:status   → lista aplicadas y pendientes.
 *
 * Una migración aplicada no se edita: el cambio va en una migración nueva.
 * Tracking: tabla public._migrations (name, applied_at). Cada archivo corre en su propia transacción.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'

const DIR = join(import.meta.dirname, '..', 'supabase', 'migrations')

/** Ejecuta SQL sin parámetros (una o varias sentencias) y devuelve las filas de la última. */
export type Exec = (sql: string) => Promise<any[]>

// El prefijo numérico define el orden. El nombre se inserta en SQL, por eso el patrón es estricto.
const files = () => readdirSync(DIR).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort()

export async function migrationStatus(exec: Exec) {
  let rows: any[] = []
  try {
    rows = await exec('select name from public._migrations')
  } catch (err: any) {
    if (err?.code !== '42P01') throw err // 42P01: la tabla aún no existe, así que todo está pendiente
  }
  const done = new Set(rows.map((r) => r.name))
  return { applied: files().filter((f) => done.has(f)), pending: files().filter((f) => !done.has(f)) }
}

export async function migrate(exec: Exec, log: (line: string) => void = () => {}) {
  await exec('create table if not exists public._migrations (name text primary key, applied_at timestamptz not null default now()); alter table public._migrations enable row level security')
  const { pending } = await migrationStatus(exec)
  for (const file of pending) {
    log(`▶ Aplicando ${file}…`)
    try {
      await exec(`begin;\n${readFileSync(join(DIR, file), 'utf8')}\n;insert into public._migrations (name) values ('${file}');\ncommit`)
    } catch (err) {
      await exec('rollback')
      throw new Error(`Falló ${file} y se deshizo su transacción: ${err instanceof Error ? err.message : err}`)
    }
  }
  return pending
}

if (import.meta.main) {
  if (!process.env.DATABASE_URL) {
    console.error('Falta DATABASE_URL en el archivo .env.')
    process.exit(1)
  }
  // Una sola conexión: la transacción de cada migración tiene que ir entera por la misma.
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1, connect_timeout: 15, onnotice: () => {} })
  const exec: Exec = async (text) => [...(await sql.unsafe(text))]
  try {
    if (process.argv.includes('--status')) {
      const { applied, pending } = await migrationStatus(exec)
      console.log(`Aplicadas (${applied.length}):`)
      applied.forEach((f) => console.log(`  ✓ ${f}`))
      console.log(`Pendientes (${pending.length}):`)
      pending.forEach((f) => console.log(`  ○ ${f}`))
    } else {
      const ran = await migrate(exec, console.log)
      console.log(ran.length ? `✅ ${ran.length} migración(es) aplicada(s).` : '✅ Sin migraciones pendientes.')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // La conexión directa de Supabase solo existe en IPv6; el pooler funciona en cualquier red.
    const hint = message.includes('ENOTFOUND') ? '\nDATABASE_URL debe ser la cadena «Session pooler» de Supabase (host …pooler.supabase.com, puerto 5432).' : ''
    console.error(`❌ ${message}${hint}`)
    process.exitCode = 1
  } finally {
    await sql.end()
  }
}
