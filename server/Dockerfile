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
