-- Миграция: Добавление поля ecoflow_charge_percent в таблицу power_status
-- Выполнить эту миграцию если таблица уже существует

-- Добавляем поле ecoflow_charge_percent
ALTER TABLE `power_status` 
ADD COLUMN IF NOT EXISTS `ecoflow_charge_percent` DECIMAL(5,2) DEFAULT NULL 
COMMENT 'Уровень заряда экофлошки в процентах' 
AFTER `voltage_v`;

-- Если используется MySQL версия < 5.7, используйте:
-- ALTER TABLE `power_status` 
-- ADD COLUMN `ecoflow_charge_percent` DECIMAL(5,2) DEFAULT NULL 
-- COMMENT 'Уровень заряда экофлошки в процентах' 
-- AFTER `voltage_v`;
