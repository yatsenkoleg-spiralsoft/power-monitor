-- База данных для мониторинга доступности розеток
-- Создает таблицы для хранения статусов и статистики

-- Основная таблица мониторинга
CREATE TABLE IF NOT EXISTS `power_status` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `timestamp` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `device_id` VARCHAR(50) NOT NULL,
  `device_name` VARCHAR(100) DEFAULT NULL,
  `is_online` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = доступно (свет есть), 0 = недоступно (света нет)',
  `response_time_ms` INT UNSIGNED DEFAULT NULL COMMENT 'Время отклика в миллисекундах',
  `power_consumption_w` DECIMAL(10,2) DEFAULT NULL COMMENT 'Текущее потребление энергии в ваттах',
  `error_message` TEXT DEFAULT NULL COMMENT 'Сообщение об ошибке, если есть',
  PRIMARY KEY (`id`),
  KEY `idx_timestamp` (`timestamp`),
  KEY `idx_device_timestamp` (`device_id`, `timestamp`),
  KEY `idx_device_date` (`device_id`, `timestamp`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Таблица мониторинга статуса розеток каждую минуту';

-- Агрегированная статистика по дням (опциональная таблица для быстрого доступа)
CREATE TABLE IF NOT EXISTS `daily_stats` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `date` DATE NOT NULL,
  `device_id` VARCHAR(50) NOT NULL,
  `device_name` VARCHAR(100) DEFAULT NULL,
  `total_checks` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Всего проверок за день',
  `minutes_online` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Минут со светом',
  `minutes_offline` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Минут без света',
  `avg_response_time_ms` DECIMAL(10,2) DEFAULT NULL COMMENT 'Среднее время отклика',
  `last_updated` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_date_device` (`date`, `device_id`),
  KEY `idx_date` (`date`),
  KEY `idx_device` (`device_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Агрегированная статистика по дням';

-- Индекс для оптимизации запросов по датам
-- (создается автоматически выше, но можно добавить составной)
