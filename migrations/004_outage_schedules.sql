-- История графиков отключений (YASNO + зеркало ДТЭК outage-data-ua).
-- Выполнить вручную в MySQL перед деплоем обновлённого power-monitor (как 001–003).
--
-- Одна строка = одна ВЕРСИЯ графика для (дата, очередь, источник). Новая строка появляется только
-- при изменении содержимого (content_hash); если график не менялся — обновляется last_seen_at.
-- Актуальная версия на дату — строка с максимальным last_seen_at.

CREATE TABLE IF NOT EXISTS outage_schedules (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    schedule_date DATE NOT NULL COMMENT 'дата графика (Киев)',
    group_code VARCHAR(16) NOT NULL COMMENT 'очередь, напр. 49.1',
    source VARCHAR(16) NOT NULL COMMENT 'yasno | dtek',
    status VARCHAR(48) NULL COMMENT 'ScheduleApplies / WaitingForSchedule / EmergencyShutdowns ...',
    slots JSON NOT NULL COMMENT '[{"start":0,"end":90,"type":"off|maybe"}] — минуты от 00:00 по Киеву',
    off_minutes SMALLINT NOT NULL DEFAULT 0,
    maybe_minutes SMALLINT NOT NULL DEFAULT 0,
    content_hash CHAR(40) NOT NULL COMMENT 'sha1(status+slots)',
    source_updated_at DATETIME NULL COMMENT 'UTC: когда источник обновил график (updatedOn / fact.update)',
    first_seen_at DATETIME NOT NULL COMMENT 'UTC: первый раз увидели эту версию',
    last_seen_at DATETIME NOT NULL COMMENT 'UTC: последний раз видели эту версию',
    origin VARCHAR(16) NOT NULL DEFAULT 'live' COMMENT 'live | backfill',
    UNIQUE KEY uq_schedule_version (schedule_date, group_code, source, content_hash),
    KEY idx_schedule_lookup (group_code, schedule_date, source, last_seen_at)
);

-- Состояние опроса источников (ограничение частоты между инстансами Cloud Run + диагностика)
CREATE TABLE IF NOT EXISTS schedule_fetch_state (
    source VARCHAR(16) PRIMARY KEY COMMENT 'schedules (общий слот) | yasno | dtek',
    last_attempt_at DATETIME NULL,
    last_ok_at DATETIME NULL,
    last_error VARCHAR(255) NULL,
    last_changes INT NOT NULL DEFAULT 0
);

INSERT INTO schedule_fetch_state (source) VALUES ('schedules'), ('yasno'), ('dtek')
ON DUPLICATE KEY UPDATE source = source;
