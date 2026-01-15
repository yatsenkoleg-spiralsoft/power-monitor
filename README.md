# Мониторинг доступности розеток Tuya

Сервис для мониторинга доступности умных розеток Tuya с записью данных в MySQL и отображением графиков доступности света.

## Переменные окружения

### Обязательные переменные

**Tuya API:**
- `TUYA_ACCESS_ID` - Client ID для Tuya API (обязательно)
- `TUYA_ACCESS_KEY` - Client Secret для Tuya API (обязательно)

**MySQL:**
- `MYSQL_HOST` - Хост MySQL (обязательно)
- `MYSQL_DATABASE` - Имя базы данных (обязательно)
- `MYSQL_USER` - Пользователь MySQL (обязательно)
- `MYSQL_PASSWORD` - Пароль MySQL (обязательно)

### Опциональные переменные

- `TUYA_API_URL` - URL Tuya API (по умолчанию: https://openapi.tuyaeu.com)
- `MYSQL_PORT` - Порт MySQL (по умолчанию: 3306)
- `DEVICE_IDS` - JSON строка с массивом устройств, например: `{"Розетка 1": "device_id_1", "Розетка 2": "device_id_2"}`
- `PORT` - Порт для сервера (по умолчанию: 8080)

## API Endpoints

### POST /monitor
Основной endpoint для Cloud Scheduler. Проверяет доступность всех розеток и записывает результаты в БД.

### GET /api/stats
Статистика за период.

### GET /api/daily
Данные для графика по дням.

### GET /api/daily-details
Детальные данные за день.

### GET /api/overall
Общая статистика.

### GET /health
Проверка состояния сервиса.

## Деплой в GCP Cloud Run

### Через gcloud CLI

```bash
gcloud run deploy tuya-power-monitor \
  --source . \
  --region europe-west1 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "TUYA_ACCESS_ID=your_access_id" \
  --set-env-vars "TUYA_ACCESS_KEY=your_access_key" \
  --set-env-vars "MYSQL_HOST=your_mysql_host" \
  --set-env-vars "MYSQL_DATABASE=your_database" \
  --set-env-vars "MYSQL_USER=your_user" \
  --set-secrets "MYSQL_PASSWORD=mysql-password:latest" \
  --memory 512Mi \
  --timeout 300
```

### Через Git (Cloud Source Repositories)

1. Создайте репозиторий в Cloud Source Repositories
2. Подключите его к Cloud Build
3. Настройте переменные окружения в Cloud Run
4. Cloud Build автоматически соберет и задеплоит при push в репозиторий

## Локальное тестирование

```bash
npm install

export TUYA_ACCESS_ID=your_access_id
export TUYA_ACCESS_KEY=your_access_key
export MYSQL_HOST=your_mysql_host
export MYSQL_DATABASE=your_database
export MYSQL_USER=your_user
export MYSQL_PASSWORD=your_password

npm start
```

## Важно

⚠️ **НЕ ХРАНИТЕ ПАРОЛИ И СЕКРЕТНЫЕ КЛЮЧИ В КОДЕ!**

Все секретные данные должны быть в переменных окружения или в GCP Secret Manager.
