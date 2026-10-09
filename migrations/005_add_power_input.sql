-- Добавляет колонку power_input_w для хранения входной мощности (заряда) устройств EcoFlow.
-- Выполнить вручную в MySQL перед деплоем обновлённого power-monitor.

ALTER TABLE power_status
    ADD COLUMN power_input_w DECIMAL(10,2) DEFAULT NULL COMMENT 'Входная мощность (заряд) в ваттах' AFTER power_consumption_w;
