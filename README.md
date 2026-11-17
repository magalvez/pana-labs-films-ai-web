# Pana Films Lab

Productora de comerciales operada por agentes de IA, con una oficina en pixel art para verlos trabajar.

## Preparar Supabase

La base de datos, los entregables y el login viven en Supabase. Se hace una sola vez.

1. **Archivo `.env`.** Rellena `DATABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` y `ALLOWED_EMAILS`. Cada una indica en `.env.example` de dónde sale. `DATABASE_URL` es la cadena **Session pooler** (puerto 5432), no la conexión directa ni el pooler de transacción.
2. **Migraciones.** `npm run db:migrate` crea las tablas y el bucket de Storage.
3. **Authentication > Users > Add user.** Crea tu usuario con correo y contraseña.
4. **Authentication > Sign In / Providers.** Desactiva el registro de usuarios nuevos.

## Migraciones

El esquema vive en `supabase/migrations/`, un archivo SQL numerado por cambio. Nada se pega a mano en el SQL Editor.

```bash
npm run db:migrate          # aplica las pendientes, en orden
npm run db:migrate:status   # lista aplicadas y pendientes
```

- Para cambiar el esquema, crea `supabase/migrations/00NN_nombre.sql` con el siguiente número.
- Una migración aplicada no se edita: el cambio va en una nueva.
- Escríbelas idempotentes cuando se pueda (`if not exists`), con un comentario que diga qué cambia y por qué.
- Cada archivo corre en una transacción. Si falla, no queda a medias.
- El servidor no arranca si hay migraciones pendientes, y dice cuáles.

## Arrancar

```bash
npm install
npm run dev
```

Abre http://localhost:5173 y entra con tu usuario. El servidor queda en http://127.0.0.1:8787. Requiere Node 24.

Por defecto todo corre en **modo simulación**: los agentes escriben entregables de muestra y no gastan.

## Agentes reales

1. Define `ANTHROPIC_API_KEY` en `.env` y reinicia `npm run dev`.
2. En Configuración, apaga el modo simulación.

Cada agente llama entonces a Claude Sonnet 5.5 y su costo se descuenta del tope del proyecto.

## Dónde desplegarlo

El servidor es un proceso que debe seguir vivo mientras un comercial se produce. Necesita un servicio con proceso permanente. Las plataformas de funciones sin servidor, como Vercel, no sirven tal cual.

## Cómo está armado

| Ruta | Qué es |
|---|---|
| `server/schemes/commercial.ts` | Etapas, agentes, entregables, auditor y aprobación de cada etapa |
| `server/agents/*.md` | Instrucciones de cada agente y rúbrica de cada auditor |
| `server/engine/pipeline.ts` | Motor: puntos de control, contrato de entrega, auditoría, reintentos, aprobaciones, presupuesto |
| `server/app.ts` | La API |
| `server/index.ts` | Arranque: conecta Supabase, el motor y la API |
| `server/store.ts` y `server/files.ts` | Postgres y Storage de Supabase |
| `supabase/migrations/` | Migraciones SQL numeradas: tablas y bucket de Storage |
| `server/migrate.ts` | Aplica las migraciones y lleva el registro en `_migrations` |
| `server/engine/simRunner.ts` | Agentes simulados |
| `server/engine/claudeRunner.ts` | Agentes reales, con herramientas confinadas a los archivos del proyecto |
| `web/src/office/world.ts` | La oficina: estado a partir de eventos y dibujo |
| Bucket `workspace` en Supabase | Entregables y `handoff.json`, en `<proyecto>/<etapa>/<agente>/v<n>/` |

Un tipo de proyecto nuevo es otro archivo en `server/schemes/` más sus instrucciones en `server/agents/`.

## Comprobar

```bash
npm test          # motor del pipeline, sobre Postgres embebido con las migraciones reales
npm run typecheck
```
