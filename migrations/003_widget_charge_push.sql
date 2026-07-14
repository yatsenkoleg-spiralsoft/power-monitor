-- Track last charge % pushed to widget via FCM (1% threshold).
-- Run manually on MySQL before deploying updated power-monitor.

ALTER TABLE grid_state
    ADD COLUMN last_pushed_charge_percent TINYINT NULL
        COMMENT 'Last EcoFlow charge % sent via FCM'
        AFTER pending_streak,
    ADD COLUMN last_pushed_grid_present TINYINT NULL
        COMMENT 'Grid state included in last FCM push'
        AFTER last_pushed_charge_percent;
