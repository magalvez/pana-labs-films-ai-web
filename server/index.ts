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
import { supabaseDb } from './store.ts'

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
const sessions = new Map<string, { email: string; until: number }>()

const sim = simRunner({ delayMs: Number(env.SIM_DELAY_MS ?? 1500), rejectOnce: ['production'] })
const real = claudeRunner({ agentsDir: join(import.meta.dirname, 'agents') })
const db = supabaseDb(env.DATABASE_URL)
const engine: Engine = createEngine({
  db,
  files: supabaseFiles(supabase),
  schemes: { commercial },
  // El interruptor de simulación del panel decide, en cada paso, entre agentes enlatados y agentes reales.
  runner: {
    runAgent: async (run) => ((await engine.getSettings()).simulation ? sim : real).runAgent(run),
    runAuditor: async (run) => ((await engine.getSettings()).simulation ? sim : real).runAuditor(run),
  },
})

const app = createApp({
  engine,
  publicConfig: { supabaseUrl: env.SUPABASE_URL, supabaseAnonKey: env.SUPABASE_ANON_KEY },
  auth: async (token) => {
    const hit = sessions.get(token)
    if (hit && hit.until > Date.now()) return hit.email
    const user = (await supabase.auth.getUser(token)).data.user
    // Un correo sin confirmar no prueba nada: cualquiera podría registrarse con la dirección de otro.
    const email = user?.email_confirmed_at ? user.email?.toLowerCase() : undefined
    if (!email || !allowed.includes(email)) return null
    if (sessions.size > 100) sessions.clear()
    sessions.set(token, { email, until: Date.now() + 60_000 })
    return email
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
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => console.log(`Pana Films Lab en http://127.0.0.1:${port}`))
// Los proyectos que estaban en marcha se retoman con la API ya arriba: pueden tardar horas y hay que poder pausarlos.
engine.resumeAll().catch((err) => console.error('No se pudieron retomar los proyectos en marcha:', err))
