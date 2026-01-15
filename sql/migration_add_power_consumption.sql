-- Миграция: Добавление поля power_consumption_w в таблицу power_status
-- Выполнить эту миграцию если таблица уже существует

-- Добавляем поле power_consumption_w
ALTER TABLE `power_status` 
ADD COLUMN IF NOT EXISTS `power_consumption_w` DECIMAL(10,2) DEFAULT NULL 
COMMENT 'Текущее потребление энергии в ваттах' 
AFTER `response_time_ms`;

-- Если используется MySQL версия < 5.7, используйте:
-- ALTER TABLE `power_status` 
-- ADD COLUMN `power_consumption_w` DECIMAL(10,2) DEFAULT NULL 
-- COMMENT 'Текущее потребление энергии в ваттах' 
-- AFTER `response_time_ms`;
