-- Миграция: Добавление полей для мониторинга Marstek VENUS-E 3.0
-- Выполнить эту миграцию если таблица power_status уже существует

-- Добавляем поля для Marstek battery
ALTER TABLE `power_status` 
ADD COLUMN IF NOT EXISTS `marstek_soc_percent` DECIMAL(5,2) DEFAULT NULL 
COMMENT 'Marstek battery state of charge (SOC) в процентах' 
AFTER `ecoflow_charge_percent`;

ALTER TABLE `power_status` 
ADD COLUMN IF NOT EXISTS `marstek_charge_w` DECIMAL(10,2) DEFAULT NULL 
COMMENT 'Marstek battery charging power в ваттах' 
AFTER `marstek_soc_percent`;

ALTER TABLE `power_status` 
ADD COLUMN IF NOT EXISTS `marstek_discharge_w` DECIMAL(10,2) DEFAULT NULL 
COMMENT 'Marstek battery discharging power в ваттах' 
AFTER `marstek_charge_w`;

ALTER TABLE `power_status` 
ADD COLUMN IF NOT EXISTS `marstek_load_w` DECIMAL(10,2) DEFAULT NULL 
COMMENT 'Marstek load power в ваттах' 
AFTER `marstek_discharge_w`;

ALTER TABLE `power_status` 
ADD COLUMN IF NOT EXISTS `marstek_pv_w` DECIMAL(10,2) DEFAULT NULL 
COMMENT 'Marstek PV (solar) power в ваттах' 
AFTER `marstek_load_w`;

ALTER TABLE `power_status` 
ADD COLUMN IF NOT EXISTS `marstek_grid_w` DECIMAL(10,2) DEFAULT NULL 
COMMENT 'Marstek grid power в ваттах' 
AFTER `marstek_pv_w`;

ALTER TABLE `power_status` 
ADD COLUMN IF NOT EXISTS `marstek_report_time` DATETIME DEFAULT NULL 
COMMENT 'Marstek cloud report timestamp' 
AFTER `marstek_grid_w`;

-- Если используется MySQL версия < 5.7, используйте варианты без IF NOT EXISTS:
-- ALTER TABLE `power_status` 
-- ADD COLUMN `marstek_soc_percent` DECIMAL(5,2) DEFAULT NULL 
-- COMMENT 'Marstek battery state of charge (SOC) в процентах' 
-- AFTER `ecoflow_charge_percent`;
-- 
-- (повторите для остальных полей)
