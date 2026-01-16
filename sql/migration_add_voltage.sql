-- Миграция: Добавление поля voltage_v в таблицу power_status
-- Выполнить эту миграцию если таблица уже существует

-- Добавляем поле voltage_v
ALTER TABLE `power_status` 
ADD COLUMN IF NOT EXISTS `voltage_v` DECIMAL(5,2) DEFAULT NULL 
COMMENT 'Напряжение в сети в вольтах' 
AFTER `power_consumption_w`;

-- Если используется MySQL версия < 5.7, используйте:
-- ALTER TABLE `power_status` 
-- ADD COLUMN `voltage_v` DECIMAL(5,2) DEFAULT NULL 
-- COMMENT 'Напряжение в сети в вольтах' 
-- AFTER `power_consumption_w`;
