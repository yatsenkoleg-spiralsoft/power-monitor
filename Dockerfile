# Используем официальный образ Node.js LTS
FROM node:18-alpine

# Устанавливаем рабочую директорию
WORKDIR /app

# Копируем package.json и package-lock.json (если есть)
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install --production --no-audit --no-fund && npm cache clean --force

# Копируем остальные файлы приложения
COPY . .

# Открываем порт (Cloud Run использует PORT из переменных окружения)
EXPOSE 8080

# Запускаем приложение
CMD ["node", "index.js"]
