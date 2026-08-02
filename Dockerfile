# Production-образ: собираем фронтенд и отдаём его тем же Express, что и API
# (single-origin — без проблем с CORS/cookie между доменами).

# --- Этап 1: сборка клиента ---
FROM node:20-slim AS client
WORKDIR /client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
# Пустой VITE_API_URL -> относительные запросы /api к тому же домену
ENV VITE_API_URL=""
RUN npx vite build

# --- Этап 2: сервер + собранный клиент ---
FROM node:20-slim
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package*.json ./
COPY server/prisma ./prisma
RUN npm install
COPY server/ ./
# Собранный фронтенд кладём в ./public — Express раздаёт его
COPY --from=client /client/dist ./public

ENV NODE_ENV=production
EXPOSE 4000

# Применяем схему БД (без --accept-data-loss: при рискованном изменении деплой упадёт,
# а не удалит данные), засеиваем справочники+админа (без демо в проде), запускаем сервер.
CMD ["sh", "-c", "npx prisma db push && npx prisma db seed && npx tsx src/index.ts"]
