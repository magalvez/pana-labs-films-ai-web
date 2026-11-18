import { useEffect, useState } from 'react'
import { api } from './api'

type Member = { email: string; role: 'admin' | 'member'; owner: boolean; createdBy: string | null; createdAt: string | null }
type Pass = { email: string; role: 'admin' | 'member'; password: string | null }
type Act = (fn: () => Promise<unknown>) => Promise<boolean>

const ROLE = { admin: 'Administración', member: 'Producción' } as const
const CAN = { admin: 'Todo, incluido el equipo, los costos, borrar y compartir con clientes', member: 'Crear producciones, seguirlas y aprobar etapas' } as const

/** El reparto del estudio: quién tiene acceso y con qué papel. */
export function Team({ me, act }: { me: string; act: Act }) {
  const [members, setMembers] = useState<Member[]>([])
  const [pass, setPass] = useState<Pass | null>(null)
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const [copied, setCopied] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

  const load = () => act(async () => setMembers(await api<Member[]>('/admin/users')))
  useEffect(() => { void load() }, [])

  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) }).catch(() => {})

  return (
    <div className="backlot team">
      <header className="backlot-head">
        <h2>Equipo</h2>
        <p>Quién entra al estudio y con qué papel. Las cuentas se crean ya activas: la contraseña la entregas tú.</p>
      </header>

      <div className="team-grid">
        <section className="credits" aria-label="Personas con acceso">
          <h3>Reparto</h3>
          <ul>
            {members.map((m) => (
              <li key={m.email}>
                <span className="who">{m.email}{m.email === me && <em> (tú)</em>}</span>
                <span className="dots" aria-hidden="true" />
                {m.owner
                  ? <span className="part">Dirección</span>
                  : <select aria-label={`Papel de ${m.email}`} value={m.role} disabled={m.email === me} onChange={(e) => act(async () => { await api(`/admin/users/${encodeURIComponent(m.email)}`, 'PUT', { role: e.target.value }); await load() })}>
                      <option value="member">{ROLE.member}</option>
                      <option value="admin">{ROLE.admin}</option>
                    </select>}
                {!m.owner && m.email !== me && (removing === m.email
                  ? <span className="confirm"><button className="danger" onClick={() => act(async () => { await api(`/admin/users/${encodeURIComponent(m.email)}`, 'DELETE'); setRemoving(null); await load() })}>Quitar acceso</button><button onClick={() => setRemoving(null)}>No</button></span>
                  : <button className="quiet" onClick={() => setRemoving(m.email)}>Quitar</button>)}
              </li>
            ))}
          </ul>
          <p className="note">Dirección son los correos de <code>ALLOWED_EMAILS</code> en el archivo <code>.env</code>. Siempre administran y no se pueden quitar desde aquí, para que nadie se quede fuera por error.</p>
        </section>

        <section className="casting" aria-label="Añadir una persona">
          <h3>Añadir al reparto</h3>
          <form onSubmit={(e) => {
            e.preventDefault()
            const form = e.currentTarget, f = new FormData(form)
            void act(async () => {
              const made = await api<Pass>('/admin/users', 'POST', { email: f.get('email'), role, password: f.get('password') || undefined })
              setPass(made); setCopied(false); form.reset(); await load()
            })
          }}>
            <label>Correo<input name="email" type="email" required maxLength={200} autoComplete="off" placeholder="nombre@panafilms.com" /></label>
            <fieldset>
              <legend>Papel</legend>
              {(['member', 'admin'] as const).map((r) => (
                <label key={r} className="part-option"><input type="radio" name="role" checked={role === r} onChange={() => setRole(r)} /><span><strong>{ROLE[r]}</strong>{CAN[r]}</span></label>
              ))}
            </fieldset>
            <label>Contraseña (opcional)<input name="password" type="text" minLength={10} autoComplete="off" placeholder="Vacío: se genera una segura" /></label>
            <button className="primary">Crear cuenta</button>
          </form>

          {pass && (
            <div className="pass" role="status">
              <div className="lanyard" aria-hidden="true" />
              <p className="pass-studio">Pana Films Lab</p>
              <p className="pass-role">{ROLE[pass.role]}</p>
              <p className="pass-email">{pass.email}</p>
              {pass.password
                ? <>
                    <p className="pass-label">Contraseña inicial</p>
                    <code className="pass-secret">{pass.password}</code>
                    <button className="primary" onClick={() => copy(`Acceso a Pana Films Lab\nCorreo: ${pass.email}\nContraseña: ${pass.password}`)}>{copied ? 'Copiado' : 'Copiar acceso'}</button>
                    <p className="note">Solo se muestra ahora. Entrégasela por un canal seguro.</p>
                  </>
                : <p className="note">Cuenta creada con la contraseña que escribiste.</p>}
              <button className="quiet" onClick={() => setPass(null)}>Cerrar</button>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
