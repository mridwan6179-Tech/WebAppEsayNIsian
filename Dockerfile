FROM node:20-bullseye-slim

WORKDIR /app

# Install build dependencies for compiling native modules like better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

# Buat direktori data untuk SQLite database dan beri hak akses penuh (kompatibel UID 1000 HF Spaces)
RUN mkdir -p /app/data && chmod -R 777 /app/data

ENV PORT=7860
EXPOSE 7860
EXPOSE 3000

CMD ["node", "server.js"]
