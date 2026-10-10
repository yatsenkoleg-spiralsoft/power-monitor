-- Состояние тихих FCM-пушей «график отключений изменился» (schedulePush.js).
-- Код создаёт таблицу сам (CREATE TABLE IF NOT EXISTS) при первом опросе; миграция — для ручного запуска/документации.

CREATE TABLE IF NOT EXISTS schedule_push_state (
    push_key VARCHAR(32) PRIMARY KEY COMMENT 'schedule:<группа>',
    content_hash CHAR(40) NOT NULL COMMENT 'sha1 эффективного графика сегодня+завтра',
    last_push_at DATETIME NULL COMMENT 'UTC: последний отправленный пуш',
    updated_at DATETIME NOT NULL COMMENT 'UTC'
);
