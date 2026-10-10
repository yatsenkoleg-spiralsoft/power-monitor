# Деплой power-monitor: история графиков отключений (YASNO + ДТЭК)

## Что добавляется

- Таблица `outage_schedules` — версии графиков по дням: `(дата, очередь, источник yasno|dtek)`.
  Новая строка пишется **только при изменении** графика (sha1 содержимого); если график тот же — обновляется `last_seen_at`.
- Таблица `schedule_fetch_state` — когда последний раз опрашивали источники (ограничение частоты между инстансами Cloud Run + диагностика).
- `POST /monitor` (Cloud Scheduler, раз в минуту) после обычной работы вызывает обновление графиков,
  но реально ходит в YASNO и в зеркало ДТЭК **не чаще раза в 15 минут**. На это отводится максимум 9 с; ошибки источников не ломают мониторинг.
  В ответе `/monitor` появилось поле `schedules` (что обновилось / `skipped`).
- `GET /api/schedules?group=49.1&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD[&source=yasno|dtek][&versions=1]` — история для страницы.
- Скрипт `scripts/backfill-schedules.js` — загрузка прошлых дней из git-истории зеркала ДТЭК (`Baskerville42/outage-data-ua`).

Источники:
- YASNO: `https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages` (Киев) — сегодня/завтра, все очереди;
- ДТЭК (зеркало): `https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/kyiv.json` — сегодня (и завтра, когда опубликовано).

По умолчанию сохраняются **все очереди** (это ~120–240 строк на источник в сутки, только при изменениях).

## Файлы

Новые:
- `migrations/004_outage_schedules.sql`
- `schedules.js` — разбор YASNO/ДТЭК, сервис (обновление с ограничением частоты, дедупликация, выдача)
- `scheduleRepo.js` — SQL для MySQL
- `githubHistory.js` — восстановление прошлых дней из истории GitHub
- `scripts/backfill-schedules.js`
- `test/*` — тесты (`node --test test/*.test.js`)

Изменённые:
- `index.js` — подключение модуля, вызов в `POST /monitor`, маршрут `GET /api/schedules` (diff: `../index.js.diff`)

`package.json`/`Dockerfile` не меняются: новых зависимостей нет (Node 18 — встроенный `fetch`).

## Перед деплоем

1. Миграция в MySQL (как 001–003), например:
   ```bash
   mysql -h <MYSQL_HOST> -u <MYSQL_USER> -p <MYSQL_DATABASE> < migrations/004_outage_schedules.sql
   ```
   Нужен MySQL ≥ 5.7.8 (тип `JSON`). Миграцию можно выполнять повторно — `IF NOT EXISTS`.
2. Скопировать файлы из `server-patch/power-monitor/` в `power-monitor/` с заменой `index.js`.
3. (Необязательно) переменные окружения Cloud Run:
   - `SCHEDULE_GROUPS` — какие очереди хранить: `*` (по умолчанию) или `49.1,45.1`
   - `SCHEDULE_REFRESH_MINUTES` — частота опроса источников, по умолчанию `15`
   - `SCHEDULE_DEFAULT_GROUP` — очередь для `/api/schedules` без `group`, по умолчанию `49.1`
   - `SCHEDULES_ENABLED=0` — выключить сбор (эндпоинт останется)

## Проверка локально (по желанию)

```bash
cd power-monitor
npm install
node --test test/*.test.js
```

## Деплой

```bash
cd power-monitor
npm install
gcloud run deploy power-monitor --source . --region europe-west1
```

> Имя сервиса — `power-monitor` (так он называется в URL `power-monitor-648695455182.europe-west1.run.app` и в `cloudbuild.yaml`).
> В старых инструкциях встречается `tuya-power-monitor`; если сомневаетесь — `gcloud run services list --region europe-west1`.
> Можно деплоить и через `cloudbuild.yaml`, как раньше.

## Проверка после деплоя

```bash
# эндпоинт отвечает (сразу после деплоя дни будут пустыми — до первого опроса)
curl "https://power-monitor-648695455182.europe-west1.run.app/api/schedules?group=49.1"
# в течение ~15 минут Scheduler вызовет POST /monitor; в логах Cloud Run нет «Графики yasno/dtek: …»-ошибок,
# а в ответе /monitor поле schedules: { yasno: { inserted: N, ... }, dtek: { ... } }
```

В MySQL:
```sql
SELECT source, last_attempt_at, last_ok_at, last_error, last_changes FROM schedule_fetch_state;
SELECT schedule_date, source, status, slots FROM outage_schedules WHERE group_code = '49.1' ORDER BY schedule_date DESC, last_seen_at DESC LIMIT 10;
```

## Загрузка прошлых дней (backfill)

История файла `data/kyiv.json` в зеркале начинается **06.11.2025**; очередь **49.1** (схема из 60 подгрупп) есть **с 28.01.2026**,
до этого ДТЭК использовал 12 очередей 1.1–6.2. На каждый день — 1 запрос к GitHub API (последний коммит до конца дня по Киеву)
и 1 загрузка raw-файла (не входит в лимит API). Без токена GitHub даёт **60 запросов в час** с IP, с токеном — 5000.

С компьютера, у которого есть доступ к MySQL (переменные `MYSQL_*` как у сервиса):
```bash
cd power-monitor
MYSQL_HOST=... MYSQL_DATABASE=... MYSQL_USER=... MYSQL_PASSWORD=... node scripts/backfill-schedules.js --days 60
```
Без прямого доступа к БД — сгенерировать SQL и выполнить его как миграцию:
```bash
node scripts/backfill-schedules.js --days 60 --sql backfill.sql
mysql -h <MYSQL_HOST> -u <MYSQL_USER> -p <MYSQL_DATABASE> < backfill.sql
```
Всю доступную историю очереди 49.1 (≈ 255 дней) — с токеном или с ожиданием сброса лимита:
```bash
GITHUB_TOKEN=<любой личный токен без прав> node scripts/backfill-schedules.js --from 2026-01-28 --groups '*'
node scripts/backfill-schedules.js --from 2026-01-28 --wait     # без токена: сам ждёт сброса лимита (~4–5 ч)
```
Повторный запуск безопасен — одинаковые версии не дублируются. Записи помечены `origin = 'backfill'`.
Для прошлых дней хранится итоговая версия графика ДТЭК (последний снимок за день); YASNO собственной истории не даёт —
его версии копятся только с момента деплоя.

## Страница roz v2

Страница сама использует `/api/schedules`, как только он появится. Пока эндпоинта нет (404), она восстанавливает графики
прошлых дней прямо в браузере из той же истории GitHub (кеш в localStorage, не больше 31 нового дня за раз).

## Тихий пуш при изменении графика (schedulePush.js)

После каждого реального опроса источников считается sha1 «эффективного» графика очереди на сегодня+завтра
(YASNO, а при аварийных/ожидании с пустыми слотами — ДТЭК; статус аварийных входит в хеш). Если хеш изменился
относительно `schedule_push_state` (таблица создаётся автоматически, см. `migrations/006_schedule_push_state.sql`) —
всем FCM-токенам уходит data-only сообщение `{type: "schedule_update", group, date, hash, timestamp}` без notification,
priority normal, collapseKey `schedule_update`. Не чаще раза в 5 мин. Первый запуск только запоминает хеш (без пуша).

Переменные: `SCHEDULE_PUSH_ENABLED=0` — выключить; `SCHEDULE_PUSH_GROUP` (по умолчанию `SCHEDULE_DEFAULT_GROUP`/`49.1`);
`SCHEDULE_PUSH_DEBOUNCE_MINUTES` (по умолчанию 5).
