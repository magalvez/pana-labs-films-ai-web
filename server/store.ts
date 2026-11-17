import postgres from 'postgres'
import type { Db } from './engine/types.ts'

/** Adapta un cliente de Postgres que recibe `$1, $2…` a la interfaz del motor, que usa `?`. */
export function pgDb(query: (text: string, params: unknown[]) => Promise<any[]>): Db {
  return (sql, ...params) => {
    let n = 0
    return query(sql.replace(/\?/g, () => `$${++n}`), params)
  }
}

/**
 * Postgres de Supabase por el pooler de sesión (puerto 5432), con sentencias preparadas.
 * Sin ellas cada consulta con parámetros hace dos idas a la base en vez de una, y el motor hace muchas seguidas.
 */
export function supabaseDb(url: string): Db {
  const sql = postgres(url, { prepare: true, max: 5, idle_timeout: 30 })
  return pgDb(async (text, params) => [...(await sql.unsafe(text, params as any[], { prepare: true }))])
}
