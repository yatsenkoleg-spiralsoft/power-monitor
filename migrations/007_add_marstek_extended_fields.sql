-- Миграция: Добавление расширенных полей Marstek для /api/minute
-- Добавляет marstek_discharge_w, marstek_load_w, marstek_grid_w, marstek_report_time
-- (marstek_soc_percent и marstek_charge_w уже были добавлены ранее)

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
