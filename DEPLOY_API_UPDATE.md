# Деплой power-monitor: виджет + FCM

## Новые endpoint'ы

- `POST /api/fcm/register` body `{ "token": "..." }` — регистрация FCM-токена
- `POST /api/fcm/unregister` body `{ "token": "..." }` — удаление токена
- `GET /api/widget` — `{ gridPresent, chargePercent, updatedAt }` для виджета

`POST /monitor` теперь при смене сети (2 мин debounce) шлёт FCM data push.

## Перед деплоем

1. Выполнить миграцию [`migrations/002_fcm_and_grid_state.sql`](migrations/002_fcm_and_grid_state.sql) в MySQL.
2. В GCP Secret Manager создать секрет с JSON service account Firebase.
3. В Cloud Run добавить переменную `FIREBASE_SERVICE_ACCOUNT_JSON` (reference на секрет).

## Деплой

```bash
cd power-monitor
npm install
gcloud run deploy tuya-power-monitor --source . --region europe-west1
```

## Проверка

```bash
curl "https://power-monitor-648695455182.europe-west1.run.app/api/widget"
curl -X POST "https://power-monitor-648695455182.europe-west1.run.app/api/fcm/register" \
  -H "Content-Type: application/json" \
  -d '{"token":"test-token"}'
```

## Android (ручные шаги)

См. [`../android-app/FCM_SETUP.md`](../android-app/FCM_SETUP.md)
