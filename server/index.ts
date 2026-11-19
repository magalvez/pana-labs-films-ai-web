import { serve } from '@hono/node-server'
import { createClient } from '@supabase/supabase-js'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { migrationStatus } from './migrate.ts'
import { claudeRunner } from './engine/claudeRunner.ts'
import { createEngine, type Engine } from './engine/pipeline.ts'
import { simRunner } from './engine/simRunner.ts'
import { supabaseFiles } from './files.ts'
import { commercial } from './schemes/commercial.ts'
import { claudeReporter } from './report.ts'
import { claudeExplorer, simExplorer } from './explore.ts'
import { supabaseDb } from './store.ts'
import { createUsers, type Role } from './users.ts'
import { createTelegram, type Telegram } from './telegram.ts'
import { createStudio, studioNotice } from './studio.ts'
import { existsSync } from 'node:fs'
import { serveStatic } from '@hono/node-server/serve-static'
import { createFinance } from './finance.ts'

const REQUIRED = ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ALLOWED_EMAILS']
const missing = REQUIRED.filter((key) => !process.env[key])
if (missing.length) {
  console.error(`Faltan variables en el archivo .env: ${missing.join(', ')}.\nMira .env.example y el README.`)
  process.exit(1)
}
const env = process.env as Record<string, string>

// La clave de servicio se queda en el servidor: valida sesiones y accede a Storage.
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const allowed = env.ALLOWED_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)

// Validar la sesión es una llamada de red a Supabase. Se recuerda 60 s por token para no repetirla en cada consulta.
// ponytail: una sesión cerrada sigue valiendo hasta 60 s; bajar el plazo si hace falta revocación inmediata.
const sessions = new Map<string, { email: string; role: Role; until: number }>()

const sim = simRunner({ delayMs: Number(env.SIM_DELAY_MS ?? 1500), rejectOnce: ['production'] })
const explorers = { sim: simExplorer(), real: claudeExplorer() }
const real = claudeRunner({ agentsDir: join(import.meta.dirname, 'agents') })
const db = supabaseDb(env.DATABASE_URL)
const engine: Engine = createEngine({
  db,
  files: supabaseFiles(supabase),
  schemes: { commercial },
  reporter: claudeReporter(),
  onEvent: (projectId, type, data) => void notice(projectId, type, data).catch((err) => console.error(`No se pudo enviar un aviso: ${err.message}`)),
  explorer: {
    suggest: (i) => (i.project.simulation ? explorers.sim : explorers.real).suggest(i),
    image: (o) => (o.project.simulation ? explorers.sim : explorers.real).image(o),
  },
  // Cada proyecto usa el modo con el que se creó; el interruptor del panel solo decide el de los nuevos.
  runner: {
    runAgent: (run) => (run.project.simulation ? sim : real).runAgent(run),
    runAuditor: (run) => (run.project.simulation ? sim : real).runAuditor(run),
  },
})

// Las cuentas viven en Supabase Auth. Se crean ya confirmadas: quien las crea entrega la contraseña en persona.
const users = createUsers({
  db,
  owners: allowed,
  identity: {
    async create(email, password) {
      const { error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true })
      if (error) throw new Error(/already/i.test(error.message) ? 'Ya existe una cuenta con ese correo en Supabase. Bórrala allí o usa otro correo.' : `No se pudo crear la cuenta: ${error.message}`)
    },
    async remove(email) {
      // ponytail: recorre la lista de cuentas; con miles de usuarios convendría buscar por correo en la base.
      for (let page = 1; page < 50; page++) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 })
        if (error) throw error
        const found = data.users.find((u) => u.email?.toLowerCase() === email)
        if (found) { const gone = await supabase.auth.admin.deleteUser(found.id); if (gone.error) throw gone.error; return }
        if (data.users.length < 200) return
      }
    },
  },
})

const telegram: Telegram = createTelegram({ db, token: env.TELEGRAM_BOT_TOKEN, username: env.TELEGRAM_BOT_USERNAME, studio: createStudio(engine, users) })
const notice = studioNotice(telegram)

const app = createApp({
  engine,
  telegram,
  users,
  finance: createFinance(db),
  publicConfig: { supabaseUrl: env.SUPABASE_URL, supabaseAnonKey: env.SUPABASE_ANON_KEY },
  auth: async (token) => {
    const hit = sessions.get(token)
    if (hit && hit.until > Date.now()) return { email: hit.email, role: hit.role }
    const user = (await supabase.auth.getUser(token)).data.user
    // Un correo sin confirmar no prueba nada: cualquiera podría registrarse con la dirección de otro.
    const email = user?.email_confirmed_at ? user.email?.toLowerCase() : undefined
    const role = email ? await users.roleOf(email) : null
    if (!email || !role) return null
    if (sessions.size > 100) sessions.clear()
    sessions.set(token, { email, role, until: Date.now() + 60_000 })
    return { email, role }
  },
})

try {
  // El servidor no migra solo: arrancar con el esquema a medias es peor que no arrancar.
  const { pending } = await migrationStatus((text) => db(text))
  if (pending.length) {
    console.error(`Hay ${pending.length} migración(es) sin aplicar: ${pending.join(', ')}.\nEjecuta: npm run db:migrate`)
    process.exit(1)
  }
} catch (err) {
  console.error(`No se pudo leer la base de datos de Supabase: ${err instanceof Error ? err.message : err}\nRevisa DATABASE_URL en el archivo .env.`)
  process.exit(1)
}
const port = Number(env.PORT ?? 8787)
// Desplegado, el mismo servidor entrega la web ya compilada (`npm run build`). En desarrollo la sirve Vite.
if (existsSync('dist/index.html')) {
  app.use('/*', serveStatic({ root: './dist' }))
  app.get('*', (c, next) => (c.req.path.startsWith('/api/') ? next() : serveStatic({ path: './dist/index.html' })(c, next)))
}
// Solo escucha en esta máquina salvo que el despliegue pida otra cosa con HOST.
const hostname = env.HOST ?? '127.0.0.1'
serve({ fetch: app.fetch, port, hostname }, () => console.log(`Pana Films Lab en http://${hostname}:${port}`))
void telegram.start()
// Los proyectos que estaban en marcha se retoman con la API ya arriba: pueden tardar horas y hay que poder pausarlos.
engine.resumeAll().catch((err) => console.error('No se pudieron retomar los proyectos en marcha:', err))
