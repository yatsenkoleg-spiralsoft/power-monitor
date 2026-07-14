-- Добавляет колонку switch_on для хранения состояния розеток и света.
-- Выполнить вручную в MySQL перед деплоем обновлённого power-monitor.

ALTER TABLE power_status
    ADD COLUMN switch_on TINYINT(1) NULL AFTER is_online;
