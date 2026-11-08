# Деплой: Расширенные поля Marstek в /api/minute

## Обзор изменений

Добавлена поддержка расширенных полей Marstek VENUS-E 3.0 в endpoint `/api/minute`:
- `marstek_discharge_w` — мощность разряда батареи (Вт)
- `marstek_load_w` — мощность нагрузки (Вт)
- `marstek_grid_w` — мощность из/в сеть (Вт)
- `marstek_report_time` — время последнего отчёта от облака Marstek

Эти поля дополняют существующие `marstek_soc_percent` и `marstek_charge_w` (добавлены в PR #21).

## Проблема

Android-приложение (Roz Device Monitor) и другие клиенты могут запрашивать только базовые поля Marstek (SOC и заряд), но не видят:
- Разряд батареи (`discharge`)
- Нагрузку (`load`)
- Сеть (`grid`)
- Время обновления данных (`reportTime`)

Хотя эти данные уже:
- Получаются от Marstek cloud API (см. `marstek.js`)
- Сохраняются в БД при каждом poll'е (см. `index.js`, POST /monitor)
- Возвращаются в `/api/current` и GET `/monitor`

## Решение

Внесены изменения в три файла + миграция БД:

### 1. minuteQuery.js
Добавлены новые поля в whitelist `MINUTE_FIELDS`:

```javascript
const MINUTE_FIELDS = new Set([
    'minute', 'date', 'time', 'timestamp', 'device_id', 'device_name', 'is_online',
    'availability_percent', 'avg_power_w', 'total_consumption_kwh', 'voltage_v',
    'ecoflow_charge_percent', 'temperature_c', 'humidity_percent',
    'marstek_soc_percent', 'marstek_charge_w', 'marstek_discharge_w', 'marstek_load_w',
    'marstek_grid_w', 'marstek_report_time',  // ← добавлено
]);
```

### 2. db.js
Добавлены новые поля в SELECT-запрос функции `getMinuteData()`:

```sql
SELECT 
    ...
    marstek_soc_percent,
    marstek_charge_w,
    marstek_discharge_w,    -- ← добавлено
    marstek_load_w,         -- ← добавлено
    marstek_grid_w,         -- ← добавлено
    marstek_report_time     -- ← добавлено
FROM power_status
```

### 3. test/minuteQuery.test.js
Добавлен комплексный тест для новых полей:

```javascript
test('marstek extended fields parsing and projection', () => {
    assert.deepStrictEqual(
        q.parseFields('marstek_discharge_w,marstek_load_w,marstek_grid_w,marstek_report_time'),
        ['minute', 'marstek_discharge_w', 'marstek_load_w', 'marstek_grid_w', 'marstek_report_time']
    );
    // ... проверка проекции полей
});
```

### 4. Миграция БД
См. `migrations/007_add_marstek_extended_fields.sql`

## Поведение

- Возвращает сырые значения из БД за минуту (Marstek отчитывается ~раз в 5 минут)
- NULL остаётся NULL, 0 остаётся 0
- Все ключи в snake_case, значения — числовые строки для мощности, datetime-строка для `marstek_report_time`
- Другие поля и эндпоинты не затронуты
- Клиенты, не запрашивающие эти поля через `?fields=`, не видят изменений

## Тестирование

✅ Все существующие тесты пройдены  
✅ Добавлен новый тест для расширенных полей Marstek

```bash
$ node --test test/minuteQuery.test.js
# tests 7
# pass 7
# fail 0
```

## Пример использования

### Запрос всех Marstek-полей

```bash
curl "https://power-monitor-648695455182.europe-west1.run.app/api/minute?deviceId=marstek&startDate=2026-11-08&endDate=2026-11-08&fields=minute,marstek_soc_percent,marstek_charge_w,marstek_discharge_w,marstek_load_w,marstek_grid_w,marstek_report_time"
```

### Ожидаемый ответ

```json
{
  "success": true,
  "data": [
    {
      "minute": "2026-11-08 10:00",
      "marstek_soc_percent": "85",
      "marstek_charge_w": "250",
      "marstek_discharge_w": "0",
      "marstek_load_w": "150",
      "marstek_grid_w": "100",
      "marstek_report_time": "2026-11-08 10:00:00"
    },
    {
      "minute": "2026-11-08 10:01",
      "marstek_soc_percent": "85",
      "marstek_charge_w": "250",
      "marstek_discharge_w": "0",
      "marstek_load_w": "150",
      "marstek_grid_w": "100",
      "marstek_report_time": "2026-11-08 10:00:00"
    },
    {
      "minute": "2026-11-08 10:05",
      "marstek_soc_percent": "86",
      "marstek_charge_w": "220",
      "marstek_discharge_w": "0",
      "marstek_load_w": "140",
      "marstek_grid_w": "80",
      "marstek_report_time": "2026-11-08 10:05:00"
    }
  ]
}
```

### Запрос только discharge и load

```bash
curl "https://power-monitor-648695455182.europe-west1.run.app/api/minute?deviceId=marstek&startDate=2026-11-08&endDate=2026-11-08&fields=minute,marstek_discharge_w,marstek_load_w"
```

## Изменения в базе данных

**ТРЕБУЕТСЯ МИГРАЦИЯ!** См. `migrations/007_add_marstek_extended_fields.sql`

### Миграция: Добавление расширенных полей Marstek

Выполните миграцию **ДО** деплоя нового кода:

```bash
mysql -h <MYSQL_HOST> -u <MYSQL_USER> -p <MYSQL_DATABASE> < migrations/007_add_marstek_extended_fields.sql
```

Или из `mysql` CLI:

```sql
USE power_monitor;
SOURCE migrations/007_add_marstek_extended_fields.sql;
```

Миграция идемпотентна (использует `ADD COLUMN IF NOT EXISTS`), поэтому безопасна для повторного выполнения.

### Новые колонки

```sql
marstek_discharge_w    DECIMAL(10,2) NULL  -- Мощность разряда (Вт)
marstek_load_w         DECIMAL(10,2) NULL  -- Мощность нагрузки (Вт)
marstek_pv_w           DECIMAL(10,2) NULL  -- Солнечная мощность (Вт)
marstek_grid_w         DECIMAL(10,2) NULL  -- Мощность сети (Вт)
marstek_report_time    DATETIME      NULL  -- Время отчёта от облака
```

**Примечание**: Колонка `marstek_pv_w` добавлена для полноты (возвращается Marstek API), хотя в данный момент не используется в `/api/minute`. Может быть добавлена в `MINUTE_FIELDS` в будущем.

## Деплой

### 1. Миграция БД

**Сначала** примените миграцию:

```bash
mysql -h <MYSQL_HOST> -u <MYSQL_USER> -p <MYSQL_DATABASE> < migrations/007_add_marstek_extended_fields.sql
```

### 2. Автоматический деплой кода

Код деплоится **автоматически** при push/merge в `master` через Cloud Build:

```bash
# После мерджа PR в master:
# Cloud Build автоматически:
# 1. Соберёт Docker образ
# 2. Загрузит его в Container Registry  
# 3. Задеплоит в Cloud Run service 'power-monitor' (europe-west1)
```

### 3. Проверка деплоя

Проверьте логи Cloud Build:

```bash
gcloud builds list --limit=5
```

Проверьте статус Cloud Run:

```bash
gcloud run services describe power-monitor --region europe-west1
```

### Ручной деплой (если нужно)

Если автоматический деплой не настроен:

```bash
cd power-monitor
gcloud run deploy power-monitor --source . --region europe-west1
```

## Проверка работы

### После деплоя

```bash
# Проверьте, что API возвращает новые поля
curl "https://power-monitor-648695455182.europe-west1.run.app/api/minute?deviceId=marstek&startDate=$(date +%Y-%m-%d)&endDate=$(date +%Y-%m-%d)&fields=minute,marstek_discharge_w,marstek_load_w,marstek_grid_w" | jq '.data[0]'
```

Ожидаемый результат:
```json
{
  "minute": "2026-11-08 14:30",
  "marstek_discharge_w": "0",
  "marstek_load_w": "150",
  "marstek_grid_w": "100"
}
```

### Проверка /api/current

Эти поля уже возвращаются в `/api/current` (не требует изменений):

```bash
curl "https://power-monitor-648695455182.europe-west1.run.app/api/current" | jq '.devices[] | select(.deviceId == "marstek")'
```

Ожидаемый результат включает:
```json
{
  "deviceId": "marstek",
  "deviceName": "Marstek VENUS-E 3.0",
  "marstekSocPercent": 85,
  "marstekChargeW": 250,
  "marstekDischargeW": 0,
  "marstekLoadW": 150,
  "marstekPvW": 0,
  "marstekGridW": 100,
  "marstekReportTime": "2026-11-08T10:05:00.000Z"
}
```

## Обратная совместимость

- ✅ Все существующие клиенты продолжают работать без изменений
- ✅ Клиенты, не запрашивающие новые поля через `?fields=`, не видят изменений
- ✅ Миграция идемпотентна (можно выполнить повторно)
- ✅ NULL/0 handling согласован с другими числовыми полями

## Связанные изменения

- PR #21: добавил `marstek_charge_w` в `/api/minute`
- Текущий PR: добавляет `marstek_discharge_w`, `marstek_load_w`, `marstek_grid_w`, `marstek_report_time`

## Точные имена полей в API

### /api/minute (snake_case)
- `marstek_soc_percent`
- `marstek_charge_w`
- `marstek_discharge_w` ← новое
- `marstek_load_w` ← новое
- `marstek_grid_w` ← новое
- `marstek_report_time` ← новое

### /api/current (camelCase)
- `marstekSocPercent`
- `marstekChargeW`
- `marstekDischargeW` ← уже есть
- `marstekLoadW` ← уже есть
- `marstekPvW` ← уже есть
- `marstekGridW` ← уже есть
- `marstekReportTime` ← уже есть

## Миграция: ручная или автоматическая?

**Ручная миграция** — миграции выполняются вручную перед деплоем нового кода.

**Не автоматически при деплое**, так как:
1. В кодебазе нет механизма автоматического применения миграций при старте
2. Существующие миграции в `migrations/` документируют историю, но применяются вручную
3. См. примеры в `DEPLOY_API_UPDATE.md`, `DEPLOY_MULTI_ECOFLOW.md` — все указывают на ручное выполнение

**Порядок деплоя:**
1. Сначала: выполнить миграцию вручную
2. Потом: задеплоить код (автоматически через Cloud Build или вручную)
