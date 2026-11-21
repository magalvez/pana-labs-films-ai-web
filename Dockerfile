# Pana Films Lab: un solo contenedor con la API, la web ya compilada, ffmpeg y lo que Remotion necesita para renderizar.
# Probado en local con Docker; ver DEPLOY.md para el despliegue.

# --- Construcción: instala todo, compila la web y deja solo lo que el servidor usa al ejecutarse.
FROM node:24-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# --- Ejecución: sin npm ni herramientas de desarrollo, con los parches de seguridad del sistema al día.
FROM node:24-trixie-slim

# ffmpeg monta, mide y exporta. Las demás son las bibliotecas que pide el navegador sin cabeza de Remotion.
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates fonts-noto-core fonts-noto-color-emoji \
    libnss3 libdbus-1-3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libgbm1 libasound2t64 \
    libxrandr2 libxkbcommon0 libxfixes3 libxcomposite1 libxdamage1 libpango-1.0-0 libcairo2 \
  && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn*

WORKDIR /app
COPY --from=build --chown=node:node /app /app
# El servidor no corre como administrador del contenedor.
USER node
# El navegador de Remotion queda dentro de la imagen: si no, se descarga (96 MB) en el primer título tras cada reinicio.
RUN node -e "import('@remotion/renderer').then((r) => r.ensureBrowser())"

# Dentro del contenedor escucha en todas las interfaces; quien publica el puerto es la plataforma.
ENV HOST=0.0.0.0 PORT=8787 NODE_ENV=production
EXPOSE 8787
# Las claves llegan como variables de entorno de la plataforma: el archivo .env no entra en la imagen.
CMD ["node", "server/index.ts"]
