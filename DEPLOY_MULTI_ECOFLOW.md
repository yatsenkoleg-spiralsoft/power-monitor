# Деплой: Поддержка нескольких устройств EcoFlow

## Обзор изменений

Добавлена поддержка мониторинга нескольких устройств EcoFlow одновременно. Каждое устройство теперь сохраняется в базе данных с уникальным `device_id` на основе его серийного номера.

## Изменения в коде

1. **ecoflow.js**:
   - Добавлена функция `getConfiguredDevices()` для получения списка устройств из переменных окружения
   - Обновлён кэш для работы с несколькими устройствами (per-device кэширование)
   - Добавлена новая функция `getEcoFlowDataForAllDevices()` для получения данных со всех устройств
   - Функции `getEcoFlowVoltageAndConsumption()` и `getEcoFlowChargeLevel()` помечены как deprecated, но оставлены для обратной совместимости

2. **index.js**:
   - Обновлён endpoint `POST /monitor` для записи данных всех EcoFlow устройств
   - Обновлён endpoint `GET /monitor` для отображения всех EcoFlow устройств
   - Обновлена функция `sortDevices()` для правильной сортировки нескольких устройств EcoFlow

3. **db.js**:
   - Обновлены SQL-запросы для работы с паттерном `ecoflow-*` в дополнение к legacy `ecoflow`
   - Обновлена функция `getLatestWidgetSnapshot()` для поиска любого EcoFlow устройства

4. **README.md**:
   - Добавлена документация по новым переменным окружения

## Переменные окружения

### Новые обязательные переменные (если используете EcoFlow)

Если у вас уже есть:
- `ECOFLOW_ACCESS_KEY` - Access Key для EcoFlow API
- `ECOFLOW_SECRET_KEY` - Secret Key для EcoFlow API

То никаких дополнительных обязательных переменных не требуется.

### Новые опциональные переменные

**`ECOFLOW_DEVICE_SNS`** (рекомендуется для нескольких устройств):
- Список серийных номеров устройств EcoFlow через запятую
- Пример: `R331ZEB4ZFBK0319,ANOTHER_SERIAL`
- Каждое устройство будет записано в БД с `device_id` вида `ecoflow-0319` (последние 4 символа серийника)

**`ECOFLOW_DEVICE_SN`** (для обратной совместимости):
- Серийный номер одного устройства EcoFlow
- Если установлен только этот параметр (без `ECOFLOW_DEVICE_SNS`), будет мониториться только это устройство
- Пример: `R331ZEB4ZFBK0319`

### Поведение переменных окружения

1. Если установлен **только `ECOFLOW_DEVICE_SN`**:
   - Работает как раньше (обратная совместимость)
   - Мониторится одно устройство

2. Если установлен **только `ECOFLOW_DEVICE_SNS`**:
   - Мониторятся все устройства из списка

3. Если установлены **оба параметра**:
   - Мониторятся все устройства из `ECOFLOW_DEVICE_SNS`
   - Плюс добавляется `ECOFLOW_DEVICE_SN`, если его нет в списке

4. Если **ни один не установлен**:
   - EcoFlow не мониторится (не считается ошибкой)

## Изменения в базе данных

**Не требуется миграция!** Существующая схема `power_status` уже поддерживает произвольные `device_id`.

### Структура device_id для EcoFlow устройств

- Старый формат (для совместимости): `ecoflow`
- Новый формат: `ecoflow-XXXX`, где `XXXX` — последние 4 символа серийного номера
  - Пример: для `R331ZEB4ZFBK0319` → `ecoflow-0319`

### Имена устройств

- Старый формат: `Экофлошка`
- Новый формат: `Экофлошка XXXX` (с последними 4 символами серийника)

## Инструкции по деплою

### Шаг 1: Обновить переменные окружения в Cloud Run

Добавьте новую переменную окружения в сервисе Cloud Run `power-monitor`:

```bash
gcloud run services update power-monitor \
  --region europe-west1 \
  --set-env-vars ECOFLOW_DEVICE_SNS="SERIAL1,SERIAL2"
```

Или через GCP Console:
1. Откройте Cloud Run → power-monitor → Edit & Deploy New Revision
2. Добавьте переменную `ECOFLOW_DEVICE_SNS` со значением `SERIAL1,SERIAL2` (замените на реальные серийники)
3. Сохраните изменения

**Важно**: Если у вас уже установлена `ECOFLOW_DEVICE_SN` и вы хотите мониторить только новые устройства:
- Либо удалите `ECOFLOW_DEVICE_SN` и используйте только `ECOFLOW_DEVICE_SNS` со всеми устройствами
- Либо оставьте оба параметра — система будет мониторить все устройства

### Шаг 2: Деплой кода

Код деплоится автоматически при push в master через Cloud Build (настроено в `cloudbuild.yaml`).

```bash
git push origin master
```

Cloud Build автоматически:
1. Соберёт Docker образ
2. Загрузит его в Container Registry
3. Задеплоит в Cloud Run

### Шаг 3: Проверка работы

После деплоя проверьте логи Cloud Run:

```bash
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=power-monitor" \
  --limit 50 \
  --format "table(timestamp,textPayload)" \
  --region europe-west1
```

Ожидаемые сообщения в логах при мониторинге (каждую минуту):
- `Экофлошка XXXX: заряд X.X%, напряжение X.X В, потребление X Вт`
- Для каждого устройства отдельная строка

### Шаг 4: Проверка данных в БД

Подключитесь к MySQL и проверьте, что данные записываются:

```sql
SELECT device_id, device_name, COUNT(*) as records, MAX(timestamp) as last_record
FROM power_status
WHERE device_id LIKE 'ecoflow%'
GROUP BY device_id, device_name
ORDER BY last_record DESC;
```

Ожидаемый результат:
- Несколько строк с `device_id` вида `ecoflow-XXXX`
- `last_record` должен быть свежим (в пределах нескольких минут)

### Шаг 5: Проверка API

Проверьте, что API возвращает данные для всех устройств:

```bash
curl https://power-monitor-XXXXXXXX-ew.a.run.app/monitor | jq '.devices[] | select(.deviceId | startswith("ecoflow"))'
```

Ожидаемый результат:
- JSON с данными для каждого EcoFlow устройства
- Каждое устройство имеет уникальный `deviceId` вида `ecoflow-XXXX`

## Обратная совместимость

### Существующие данные

Все существующие данные с `device_id = 'ecoflow'` остаются в БД и продолжают работать:
- API `/api/stats`, `/api/daily` и другие включают эти данные
- Виджет (`/api/widget`) продолжает показывать заряд (берёт первое найденное EcoFlow устройство)
- Графики отключений не затронуты

### Без изменения переменных окружения

Если не добавить `ECOFLOW_DEVICE_SNS`:
- Система продолжит работать с существующим `ECOFLOW_DEVICE_SN` как раньше
- Никаких изменений в поведении не произойдёт

### Widget и Push-уведомления

Виджет и push-уведомления используют заряд **первого найденного** EcoFlow устройства (для обратной совместимости):
- Если есть legacy `ecoflow` — используется он
- Иначе используется первое устройство с паттерном `ecoflow-*`

## Откат (Rollback)

Если что-то пошло не так:

### Вариант 1: Откат кода через Cloud Run

```bash
gcloud run services update-traffic power-monitor \
  --region europe-west1 \
  --to-revisions PREVIOUS_REVISION=100
```

Где `PREVIOUS_REVISION` — имя предыдущей ревизии (можно найти в Cloud Run Console).

### Вариант 2: Удалить новую переменную окружения

```bash
gcloud run services update power-monitor \
  --region europe-west1 \
  --remove-env-vars ECOFLOW_DEVICE_SNS
```

Система вернётся к мониторингу одного устройства через `ECOFLOW_DEVICE_SN`.

### Вариант 3: Откат через Git

```bash
git revert HEAD
git push origin master
```

Cloud Build автоматически задеплоит предыдущую версию.

## Проблемы и решения

### Проблема: Не видно данных для второго устройства

**Проверьте:**
1. Переменная окружения `ECOFLOW_DEVICE_SNS` установлена правильно (через запятую, без пробелов)
2. Серийные номера корректны (проверьте в EcoFlow Developer Console)
3. У API-ключей есть доступ к обоим устройствам
4. Логи Cloud Run показывают успешное получение данных

**Решение:**
```bash
# Проверьте переменные окружения
gcloud run services describe power-monitor --region europe-west1 --format "value(spec.template.spec.containers[0].env)"

# Проверьте логи
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=power-monitor" \
  --limit 20 --format "table(timestamp,textPayload)"
```

### Проблема: API EcoFlow возвращает ошибку 401/403

**Причина:** API-ключи не имеют доступа ко второму устройству.

**Решение:**
1. Зайдите в EcoFlow Developer Console
2. Убедитесь, что оба устройства добавлены в ваше приложение
3. При необходимости пересоздайте API-ключи

### Проблема: Старые данные не показываются

**Причина:** SQL-запросы обновлены для работы с паттерном `ecoflow-%`.

**Проверка:** Старые данные с `device_id = 'ecoflow'` должны продолжать работать благодаря условию:
```sql
(device_id = 'ecoflow' OR device_id LIKE 'ecoflow-%')
```

Если данные не отображаются, проверьте логи MySQL:
```sql
SELECT device_id, COUNT(*) FROM power_status GROUP BY device_id;
```

## Мониторинг

Рекомендуется добавить алерты в GCP Monitoring:

1. **Отсутствие данных от устройства**:
   - Метрика: количество записей в `power_status` за последние 5 минут
   - Условие: < 5 записей для каждого `device_id`

2. **Ошибки EcoFlow API**:
   - Метрика: количество ошибок в логах с фильтром `"Ошибка получения данных EcoFlow"`
   - Условие: > 0 за последние 5 минут

3. **Низкий заряд батареи**:
   - Метрика: `ecoflow_charge_percent` из таблицы `power_status`
   - Условие: < 20% для любого устройства

## Контакты

При возникновении проблем проверьте:
1. Логи Cloud Run
2. Статус Cloud Build
3. Доступность MySQL
4. EcoFlow API статус (https://developer-eu.ecoflow.com/)
