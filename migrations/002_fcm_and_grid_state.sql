-- FCM tokens and grid power state detector for widget / push notifications.
-- Run manually on MySQL before deploying updated power-monitor.

CREATE TABLE IF NOT EXISTS fcm_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    token VARCHAR(512) NOT NULL,
    platform VARCHAR(32) NOT NULL DEFAULT 'android',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_fcm_token (token)
);

CREATE TABLE IF NOT EXISTS grid_state (
    id TINYINT PRIMARY KEY,
    confirmed_present TINYINT NULL COMMENT '1=grid present, 0=absent, NULL=unknown',
    pending_present TINYINT NULL,
    pending_streak INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

INSERT INTO grid_state (id, confirmed_present, pending_present, pending_streak)
VALUES (1, NULL, NULL, 0)
ON DUPLICATE KEY UPDATE id = id;
