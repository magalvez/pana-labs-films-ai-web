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

Por defecto todo corre en **modo simulación**: los agentes escriben entregables de muestra y no gastan. Los videos, imágenes y audios de muestra los hace ffmpeg en el servidor.

Requiere **ffmpeg** instalado (`brew install ffmpeg`), también en simulación.

## Agentes reales

1. Define `ANTHROPIC_API_KEY`, `FAL_KEY`, `ELEVENLABS_API_KEY` y `GEMINI_API_KEY` en `.env` y reinicia `npm run dev`.
2. En Configuración, apaga el modo simulación.
3. Crea el proyecto con un tope de presupuesto bajo.

Cada agente llama entonces a Claude Sonnet 5.5 y genera de verdad. Todo el gasto se descuenta del tope del proyecto.

## Generación y montaje

| Qué | Con qué | Costo |
|---|---|---|
| Imágenes de referencia y storyboard | fal.ai, Nano Banana 2 | 0.08 USD por imagen |
| Tomas de video | fal.ai, Kling 2.6 Pro, a partir del cuadro del storyboard | 0.07 USD por segundo |
| Pruebas de movimiento | fal.ai, PixVerse V6 a 360p | 0.025 USD por segundo |
| Voz, música y efectos | ElevenLabs | Por caracteres y por minuto |
| Revisión de video en movimiento | Gemini 3.8 Flash | 1 a 3 centavos por consulta |
| Corte, color, mezcla, máster y versiones | ffmpeg en el servidor | Sin costo |
| Cierre de marca y textos en pantalla | Remotion en el servidor | Sin costo |

Los modelos y las tarifas están en `server/media/prices.ts`. El costo se estima con esa tabla, no con la factura del proveedor.

- **Presupuesto.** Una herramienta de pago se niega a generar si su costo no cabe en lo que le queda al proyecto.
- **Producto y logo.** Nunca se generan. El cliente sube su logo y sus fotos de producto al crear el proyecto: el cierre usa el logo real y las tomas usan las fotos como referencia.
- **Rehacer un plano.** Una versión nueva de un agente parte de una copia de la anterior, así que rehace solo lo que le devolvieron.
- **Procedencia.** Cada archivo generado o montado queda en la tabla `assets` con herramienta, modelo, prompt, costo, licencia y medidas técnicas. Los auditores miden los archivos, no se fían de los informes.
- **Música.** ElevenLabs no la permite en el plan gratuito, que además no da licencia comercial. Sin plan de pago, la pieza sale sin música y el informe de procedencia lo avisa.
- **Revisión en movimiento.** Claude solo ve cuadros sueltos. Para juzgar un corte o una toma, los agentes y los auditores piden a Gemini que mire el video completo y luego confirman el instante por su cuenta.
- **Volver atrás.** Desde una aprobación se puede devolver trabajo a un agente de una etapa anterior; lo posterior se actualiza a partir de lo ya entregado.
- **Remotion.** Es gratis para empresas de hasta 3 personas. Con 4 o más hace falta su licencia de empresa.
- **Primer render.** La primera vez que se renderiza un cierre, Remotion descarga un navegador de unos 140 MB.

## Producciones, equipo y clientes

Estas pantallas solo las ven los administradores, desde la barra superior.

- **Producciones.** Todas las producciones con su estado y su costo. Al abrir una, la hoja de costos: total frente al tope, cuánto fue de Claude y cuánto de generación, primera pasada frente a repeticiones, por etapa y por agente, y la bitácora de cada ejecución. Desde ahí se pausa, reanuda, cancela o borra.
- **Para el cliente.** Un enlace de solo lectura abre una página con la pieza, sus versiones y la memoria de producción, que Claude escribe a partir de los entregables. No pide cuenta ni enseña costos. El enlace vence, se puede revocar y cuenta las visitas.
- **Equipo.** Crear cuentas y darles papel: Administración (todo) o Producción (crear, seguir y aprobar). Las cuentas se crean ya activas; si no escribes contraseña se genera una y se muestra una sola vez. Los correos de `ALLOWED_EMAILS` son la dirección: siempre administran y no se quitan desde la pantalla.

El enlace para clientes apunta a este servidor. Mientras corra en tu máquina, solo se abre desde ella; para enviarlo a un cliente hay que desplegar la app.

## Costos

Lo que más cuesta no es generar video, sino los agentes de Claude, sobre todo cuando repiten trabajo y cuando miran muchas imágenes. La caché de prompts está activada: en cada paso de un agente, lo que ya se envió antes se cobra como lectura de caché. El costo real de cada producción se ve en su hoja de costos.

## Dónde desplegarlo

El servidor es un proceso que debe seguir vivo mientras un comercial se produce. Necesita un servicio con proceso permanente. Las plataformas de funciones sin servidor, como Vercel, no sirven tal cual.

## Cómo está armado

| Ruta | Qué es |
|---|---|
| `server/schemes/commercial.ts` | Etapas, agentes, entregables, auditor y aprobación de cada etapa |
| `server/agents/*.md` | Instrucciones de cada agente y rúbrica de cada auditor |
| `server/engine/pipeline.ts` | Motor: puntos de control, contrato de entrega, auditoría, reintentos, aprobaciones, presupuesto |
| `server/app.ts` | La API |
| `server/users.ts` | Quién tiene acceso y con qué papel |
| `server/report.ts` | La memoria de producción para el cliente |
| `web/src/Admin.tsx`, `Team.tsx`, `Preview.tsx` | Producciones, Equipo y la vista del cliente |
| `server/index.ts` | Arranque: conecta Supabase, el motor y la API |
| `server/store.ts` y `server/files.ts` | Postgres y Storage de Supabase |
| `supabase/migrations/` | Migraciones SQL numeradas: tablas y bucket de Storage |
| `server/migrate.ts` | Aplica las migraciones y lleva el registro en `_migrations` |
| `server/engine/simRunner.ts` | Agentes simulados |
| `server/engine/claudeRunner.ts` | Agentes reales, con herramientas confinadas a los archivos del proyecto |
| `server/engine/tools.ts` | Herramientas de ver, generar y montar que reciben los agentes |
| `server/media/` | Conectores: fal.ai, ElevenLabs, ffmpeg, Remotion y la tabla de tarifas |
| `remotion/` | Composiciones del cierre de marca y de los textos en pantalla |
| `web/src/office/world.ts` | La oficina: estado a partir de eventos y dibujo |
| Bucket `workspace` en Supabase | Entregables y `handoff.json`, en `<proyecto>/<etapa>/<agente>/v<n>/`. Archivos del cliente, en `brands/<marca>/` |

Un tipo de proyecto nuevo es otro archivo en `server/schemes/` más sus instrucciones en `server/agents/`.

## Comprobar

```bash
npm test          # motor sobre Postgres embebido con las migraciones reales, y montaje con ffmpeg
npm run typecheck
```
