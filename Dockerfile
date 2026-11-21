# Pana Films Lab: un solo contenedor con la API, la web ya compilada, ffmpeg y lo que Remotion necesita para renderizar.
# Sin probar en un despliegue real todavía: ver DEPLOY.md.
FROM node:24-bookworm-slim

# ffmpeg monta, mide y exporta. Las demás son las bibliotecas que pide el navegador sin cabeza de Remotion.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates fonts-noto-core fonts-noto-color-emoji \
    libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 libasound2 \
    libxrandr2 libxkbcommon0 libxfixes3 libxcomposite1 libxdamage1 libpango-1.0-0 libcairo2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# El navegador de Remotion queda dentro de la imagen: si no, se descarga (96 MB) en el primer título tras cada reinicio.
RUN node -e "import('@remotion/renderer').then((r) => r.ensureBrowser())"
COPY . .
RUN npm run build

# Dentro del contenedor escucha en todas las interfaces; quien publica el puerto es la plataforma.
ENV HOST=0.0.0.0 PORT=8787 NODE_ENV=production
EXPOSE 8787
# Las claves llegan como variables de entorno de la plataforma: el archivo .env no entra en la imagen.
CMD ["node", "server/index.ts"]
