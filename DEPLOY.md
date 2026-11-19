# Publicar Pana Films Lab

Hoy el estudio corre en una sola máquina (`npm run dev`). Esta guía deja listo el paso a un servidor.
El `Dockerfile` no se ha probado todavía en un despliegue real: la primera vez, sigue los pasos en orden y comprueba cada uno.

## Qué necesita el servidor

- **Un proceso que no se apague.** Los agentes trabajan durante horas y el servidor retoma solo los proyectos en marcha al arrancar. No sirve una plataforma de funciones que duerma o corte a los pocos minutos (Vercel, Netlify): hace falta un contenedor siempre encendido. Opciones: Railway, Fly.io, Render o un VPS con Docker.
- **Una sola instancia.** El motor lleva en memoria qué proyecto está corriendo y sondea Telegram: con dos copias a la vez, dos agentes harían el mismo trabajo. No actives el escalado automático.
- **Memoria:** 2 GB como mínimo. Remotion abre un navegador sin cabeza para los títulos y ffmpeg monta video.
- **Disco:** solo temporal. Los archivos viven en Supabase Storage.

## Antes de publicar

1. **Cierra el registro de usuarios en Supabase**: Authentication, Sign In / Providers, desactiva "Allow new users to sign up". Las cuentas se crean desde la pantalla Equipo.
2. **Aplica las migraciones** desde tu máquina, contra la base real: `npm run db:migrate`. El servidor se niega a arrancar si falta alguna.
3. **Ten a mano las variables** del archivo `.env`. En la plataforma se cargan como variables de entorno o secretos, nunca dentro de la imagen ni del repositorio.

## Variables de entorno

Las mismas de `.env.example`, más las de despliegue:

| Variable | Para qué |
|---|---|
| `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Base de datos, archivos y sesiones |
| `ALLOWED_EMAILS` | Correos de la dirección: siempre administran |
| `ANTHROPIC_API_KEY`, `FAL_KEY`, `ELEVENLABS_API_KEY`, `GEMINI_API_KEY` | Agentes, generación, voz y revisión de video |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` | Avisos por Telegram (opcional) |
| `HOST` | `0.0.0.0` en el contenedor (ya lo pone el Dockerfile). Sin ella, el servidor solo escucha en la propia máquina |
| `PORT` | Puerto interno, 8787 por defecto |

## Construir y probar en tu máquina

```
docker build -t pana-films-lab .
docker run --rm -p 8787:8787 --env-file .env -e HOST=0.0.0.0 pana-films-lab
```

Abre `http://localhost:8787`: el mismo servidor entrega la web compilada y la API. Crea un proyecto en simulación y comprueba que llega a entregarse (prueba ffmpeg y Remotion dentro del contenedor).

## Publicar

1. Crea el servicio en la plataforma elegida a partir de este repositorio, con el `Dockerfile`.
2. Carga las variables de entorno.
3. Fija una sola instancia, 2 GB de memoria y sin suspensión por inactividad.
4. Activa HTTPS con el dominio de la plataforma o el tuyo.
5. Entra con una cuenta de `ALLOWED_EMAILS` y corre un proyecto en simulación antes de apagar el modo simulación.

## Lo que cambia al estar en internet

- **Los enlaces para clientes** (`/p/...`) pasan a funcionar fuera de tu red: es para lo que sirven. Cada uno vence y se puede revocar desde Producciones.
- **El gasto real** depende de quién tenga cuenta: revisa la pantalla Equipo y los topes de presupuesto por defecto.
- **Telegram** sigue funcionando por sondeo. Si alguna vez corre más de una copia del servidor, habrá que pasarlo a webhook.
