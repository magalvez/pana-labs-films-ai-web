import { randomBytes } from 'node:crypto'
import type { Db } from './engine/types.ts'

export type Role = 'admin' | 'member'
export type Member = { email: string; role: Role; owner: boolean; createdBy: string | null; createdAt: string | null }

/** Lo que se necesita del proveedor de identidad: crear una cuenta ya confirmada y borrarla. */
export type Identity = {
  create(email: string, password: string): Promise<void>
  remove(email: string): Promise<void>
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Quién puede entrar y con qué permisos. Los dueños vienen del archivo .env y siempre son administradores:
 * así nadie puede quedarse fuera por un error en esta pantalla. El resto se guarda en la tabla `members`.
 */
export function createUsers({ db, identity, owners }: { db: Db; identity: Identity; owners: string[] }) {
  const isOwner = (email: string) => owners.includes(email)

  async function roleOf(email: string): Promise<Role | null> {
    if (isOwner(email)) return 'admin'
    return (await db('SELECT role FROM members WHERE email = ?', email))[0]?.role ?? null
  }

  async function list(): Promise<Member[]> {
    const rows = await db('SELECT email, role, created_by, created_at FROM members ORDER BY created_at, email')
    return [
      ...owners.map((email) => ({ email, role: 'admin' as const, owner: true, createdBy: null, createdAt: null })),
      ...rows.filter((r) => !isOwner(r.email)).map((r) => ({ email: r.email, role: r.role, owner: false, createdBy: r.created_by, createdAt: r.created_at })),
    ]
  }

  /** Crea la cuenta y le da acceso. Sin contraseña, genera una que se muestra una sola vez a quien la crea. */
  async function create(input: { email: unknown; role: unknown; password?: unknown }, by: string) {
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
    const role = input.role === 'admin' ? 'admin' : input.role === 'member' ? 'member' : null
    if (!EMAIL.test(email) || email.length > 200) throw new Error('Escribe un correo válido')
    if (!role) throw new Error('El rol debe ser administrador o miembro')
    if ((await roleOf(email)) !== null) throw new Error('Esa persona ya tiene acceso')
    const given = typeof input.password === 'string' ? input.password : ''
    if (given && given.length < 10) throw new Error('La contraseña necesita al menos 10 caracteres')
    const password = given || randomBytes(15).toString('base64url')
    await identity.create(email, password)
    await db('INSERT INTO members (email, role, created_by, created_at) VALUES (?,?,?,?)', email, role, by, new Date().toISOString())
    return { email, role, password: given ? null : password }
  }

  async function setRole(email: string, role: unknown, by: string) {
    if (role !== 'admin' && role !== 'member') throw new Error('El rol debe ser administrador o miembro')
    if (isOwner(email)) throw new Error('Los dueños se definen en el archivo .env y siempre son administradores')
    if (email === by) throw new Error('No puedes cambiar tu propio rol')
    const changed = await db('UPDATE members SET role = ? WHERE email = ? RETURNING email', role, email)
    if (!changed.length) throw new Error('Esa persona no tiene acceso')
  }

  async function remove(email: string, by: string) {
    if (isOwner(email)) throw new Error('Los dueños se quitan del archivo .env, no desde aquí')
    if (email === by) throw new Error('No puedes quitarte el acceso a ti mismo')
    const gone = await db('DELETE FROM members WHERE email = ? RETURNING email', email)
    if (!gone.length) throw new Error('Esa persona no tiene acceso')
    // Sin fila en `members` ya no entra. Borrar la cuenta es limpieza: si falla, el acceso sigue cerrado.
    await identity.remove(email).catch((err) => console.error(`No se pudo borrar la cuenta de ${email}:`, err))
  }

  return { roleOf, list, create, setRole, remove }
}
export type Users = ReturnType<typeof createUsers>
