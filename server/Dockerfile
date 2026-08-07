# ⚠️ DEV ONLY. Этот образ запускает `npm run dev` (tsx watch) без NODE_ENV=production.
# В прод НЕ использовать: при NODE_ENV≠production config.ts берёт слабый дефолт JWT_SECRET
# ('dev_secret_change_me') → возможна подделка токенов. Прод собирается корневым Dockerfile.
FROM node:20-slim

# Prisma требует openssl; в slim-образе его нужно доустановить
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Устанавливаем зависимости (prisma generate вызывается в postinstall, поэтому
# схема должна быть скопирована до npm install)
COPY package*.json ./
COPY prisma ./prisma
RUN npm install

COPY . .

EXPOSE 4000

CMD ["npm", "run", "dev"]
