# Dockerfile per Discord Soundboard Bot
FROM node:20-bookworm-slim

# Dipendenze sistema (ffmpeg per audio + tini per gestione segnali)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia package files prima per sfruttare la cache Docker
COPY package*.json ./

RUN npm install --omit=dev && npm cache clean --force

# Copia il resto del codice
COPY . .

# Crea le cartelle che serviranno (poi montate come volumi)
RUN mkdir -p /app/sounds /app/config /app/logs

# Le porte 80 e 443 sono privilegiate; servono per HTTPS
EXPOSE 80 443

# tini come PID 1 per gestire correttamente i segnali
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "index.js"]
