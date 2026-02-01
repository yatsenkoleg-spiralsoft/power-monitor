-- Миграция: добавление колонок температуры и влажности для датчика T & H Sensor

ALTER TABLE `power_status`
  ADD COLUMN `temperature_c` DECIMAL(4,2) DEFAULT NULL COMMENT 'Температура °C (датчик T&H)' AFTER `ecoflow_charge_percent`,
  ADD COLUMN `humidity_percent` DECIMAL(4,2) DEFAULT NULL COMMENT 'Влажность % (датчик T&H)' AFTER `temperature_c`;
