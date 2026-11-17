-- Enhanced grid state tracking for internet outage detection
-- Adds fields to distinguish between power outage and internet outage

ALTER TABLE grid_state
    ADD COLUMN last_confirmed_present TINYINT NULL COMMENT '1=grid present, 0=absent, NULL=unknown (last confirmed state before UNKNOWN)' AFTER confirmed_present,
    ADD COLUMN unknown_since DATETIME NULL COMMENT 'UTC: when continuous UNKNOWN state began' AFTER pending_streak,
    ADD COLUMN pending_off_minutes INT NOT NULL DEFAULT 0 COMMENT 'Minutes of consecutive ABSENT readings (for 2-min debounce)' AFTER pending_streak;

-- Migrate existing confirmed_present to last_confirmed_present if not NULL
UPDATE grid_state SET last_confirmed_present = confirmed_present WHERE confirmed_present IS NOT NULL;
