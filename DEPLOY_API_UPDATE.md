# Деплой power-monitor после изменений API

Добавлены endpoint'ы:
- `GET /api/current` — последний снимок из MySQL
- `GET /monitor` — live-снимок (Tuya + EcoFlow), без записи в БД

## Деплой

```bash
cd power-monitor
gcloud run deploy tuya-power-monitor --source . --region europe-west1
```

## Проверка

```bash
curl "https://power-monitor-648695455182.europe-west1.run.app/api/current"
curl "https://power-monitor-648695455182.europe-west1.run.app/monitor"
```

Ожидаемый формат:

```json
{
  "success": true,
  "source": "database",
  "timestamp": "2026-07-14T19:23:00.000Z",
  "devices": [
    {
      "deviceId": "obogrevatel",
      "deviceName": "Обогреватель",
      "isOnline": true,
      "powerConsumptionW": 103.6,
      "voltageV": 204.9
    }
  ]
}
```
