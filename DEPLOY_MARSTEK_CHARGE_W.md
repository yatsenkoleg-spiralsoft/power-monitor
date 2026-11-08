# Деплой: Добавление marstek_charge_w в /api/minute

## Обзор изменений

Добавлена поддержка поля `marstek_charge_w` в endpoint `/api/minute`, чтобы Android-приложение (Roz Device Monitor) могло строить график мощности заряда Marstek VENUS-E.

## Проблема

При запросе `GET /api/minute?deviceId=marstek&startDate=2026-11-08&endDate=2026-11-08&fields=is_online,marstek_soc_percent,marstek_charge_w` поле `marstek_charge_w` игнорировалось, хотя:
- В базе данных есть колонка `marstek_charge_w`
- Endpoint `/api/current` возвращает это поле как `marstekChargeW`

## Решение

Внесены минимальные изменения в три файла:

### 1. minuteQuery.js
Добавлено `marstek_charge_w` в whitelist разрешённых полей:

```javascript
const MINUTE_FIELDS = new Set([
    'minute', 'date', 'time', 'timestamp', 'device_id', 'device_name', 'is_online',
    'availability_percent', 'avg_power_w', 'total_consumption_kwh', 'voltage_v',
    'ecoflow_charge_percent', 'temperature_c', 'humidity_percent',
    'marstek_soc_percent', 'marstek_charge_w',  // ← добавлено
]);
```

### 2. db.js
Добавлено `marstek_charge_w` в SELECT-запрос функции `getMinuteData()`:

```sql
SELECT 
    ...
    marstek_soc_percent,
    marstek_charge_w  -- ← добавлено
FROM power_status
```

### 3. test/minuteQuery.test.js
Добавлен тест для проверки парсинга и проекции поля `marstek_charge_w`:

```javascript
test('marstek_charge_w field parsing and projection', () => {
    assert.deepStrictEqual(q.parseFields('marstek_charge_w,marstek_soc_percent'), 
        ['minute', 'marstek_charge_w', 'marstek_soc_percent']);
    const rows = [{ minute: '2026-11-08 10:00', marstek_charge_w: '250', marstek_soc_percent: '85', device_id: 'marstek' }];
    assert.deepStrictEqual(q.projectRows(rows, ['minute', 'marstek_charge_w']), 
        [{ minute: '2026-11-08 10:00', marstek_charge_w: '250' }]);
});
```

## Поведение

- Возвращает сырые значения из БД за минуту (не усреднённые, т.к. Marstek отчитывается ~раз в 5 минут)
- NULL остаётся NULL, 0 остаётся 0 (как у других числовых полей)
- Ключ в snake_case, значение — числовая строка (формат как у остальных полей)
- Другие поля не затронуты
- Клиенты, не запрашивающие это поле, не видят изменений

## Тестирование

✅ Все существующие тесты пройдены  
✅ Добавлен новый тест для `marstek_charge_w`

```bash
$ node --test test/minuteQuery.test.js
# tests 6
# pass 6
# fail 0
```

## Пример использования

### Запрос

```bash
curl "https://power-monitor-648695455182.europe-west1.run.app/api/minute?deviceId=marstek&startDate=2026-11-08&endDate=2026-11-08&fields=minute,marstek_soc_percent,marstek_charge_w"
```

### Ожидаемый ответ

```json
{
  "success": true,
  "data": [
    {
      "minute": "2026-11-08 10:00",
      "marstek_soc_percent": "85",
      "marstek_charge_w": "250"
    },
    {
      "minute": "2026-11-08 10:01",
      "marstek_soc_percent": "85",
      "marstek_charge_w": "250"
    },
    {
      "minute": "2026-11-08 10:05",
      "marstek_soc_percent": "86",
      "marstek_charge_w": "220"
    }
  ]
}
```

## Деплой

### Автоматический деплой

Код деплоится **автоматически** при push/merge в `master` через Cloud Build (настроено в `cloudbuild.yaml`).

```bash
# После мерджа PR в master:
# Cloud Build автоматически:
# 1. Соберёт Docker образ
# 2. Загрузит его в Container Registry  
# 3. Задеплоит в Cloud Run service 'power-monitor' (europe-west1)
```

### Проверка деплоя

Проверьте логи Cloud Build:

```bash
gcloud builds list --limit=5
```

Проверьте статус Cloud Run:

```bash
gcloud run services describe power-monitor --region europe-west1
```

### Ручной деплой (если нужно)

Если автоматический деплой не настроен или требуется ручной деплой:

```bash
cd power-monitor
gcloud run deploy power-monitor --source . --region europe-west1
```

## Проверка работы

### После деплоя

```bash
# Проверьте, что API возвращает поле marstek_charge_w
curl "https://power-monitor-648695455182.europe-west1.run.app/api/minute?deviceId=marstek&startDate=$(date +%Y-%m-%d)&endDate=$(date +%Y-%m-%d)&fields=minute,marstek_charge_w" | jq '.data[0]'
```

Ожидаемый результат:
```json
{
  "minute": "2026-11-08 14:30",
  "marstek_charge_w": "250"
}
```

### Логи Cloud Run

```bash
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=power-monitor" \
  --limit 20 \
  --format "table(timestamp,textPayload)" \
  --region europe-west1
```

## Изменения в базе данных

**НЕ требуется миграция!** Колонка `marstek_charge_w` уже существует в БД.

## Обратная совместимость

- Все существующие клиенты продолжают работать без изменений
- Клиенты, не запрашивающие `marstek_charge_w` через `?fields=`, не видят изменений
- Клиенты, уже запрашивавшие `marstek_charge_w`, теперь получат это поле (ранее оно игнорировалось)

## Pull Request

PR: https://github.com/yatsenkoleg-spiralsoft/power-monitor/pull/21

Коммит: `Add marstek_charge_w field to /api/minute endpoint`
