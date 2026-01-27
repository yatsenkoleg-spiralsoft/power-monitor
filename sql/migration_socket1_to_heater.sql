-- Миграция: данные с «Розетки 1» начиная с 27.01.2025 19:24 (Киев) включительно
-- переписать как устройство «Обогреватель» (device_id='obogrevatel').

-- Если timestamp хранится в UTC (типично для Cloud SQL):
-- 27.01.2025 19:24 Киев (UTC+2) = 27.01.2025 17:24 UTC
UPDATE power_status
SET device_id = 'obogrevatel',
    device_name = 'Обогреватель'
WHERE device_id = 'bf3c70a960958bcf11ruml'
  AND timestamp >= '2025-01-27 17:24:00';

-- Альтернатива: если timestamp уже в киевском времени, используйте:
--   AND timestamp >= '2025-01-27 19:24:00'
-- Или явно по Киеву при хранении в UTC:
--   AND CONVERT_TZ(timestamp, '+00:00', '+02:00') >= '2025-01-27 19:24:00'
