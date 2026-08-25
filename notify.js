const axios = require('axios');

const DEFAULT_SMS_URL = 'https://sms.samber.in.ua/index.php';
const FAIL_STREAK_ALERT_AFTER = 3;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

const state = {
    failStreak: 0,
    alerted: false,
    lastAlertAt: 0,
};

function getSmsBaseUrl() {
    const raw = (process.env.ROZ_SMS_NOTIFY_URL || DEFAULT_SMS_URL).trim();
    return raw.replace(/\/$/, '');
}

/**
 * Send text via sms.samber.in.ua (?m=...). Does not throw.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function sendSmsAlert(text) {
    const message = String(text || '').trim();
    if (!message) {
        return false;
    }

    const url = `${getSmsBaseUrl()}?m=${encodeURIComponent(message)}`;
    try {
        const response = await axios.get(url, {
            timeout: 5000,
            validateStatus: () => true,
        });
        if (response.status >= 200 && response.status < 300) {
            console.log(`SMS notify OK: ${message}`);
            return true;
        }
        console.error(`SMS notify HTTP ${response.status}: ${message}`);
        return false;
    } catch (error) {
        console.error(`SMS notify failed: ${error.message}`);
        return false;
    }
}

/**
 * In-memory DB write health for /monitor runs (no MySQL dependency).
 * @param {boolean} dbOk at least one savePowerStatus succeeded this run
 */
async function recordMonitorDbHealth(dbOk) {
    if (dbOk) {
        if (state.alerted) {
            await sendSmsAlert('Roz: MySQL OK');
        }
        state.failStreak = 0;
        state.alerted = false;
        return;
    }

    state.failStreak += 1;
    const now = Date.now();
    const dueByStreak = state.failStreak >= FAIL_STREAK_ALERT_AFTER;
    const cooledDown = !state.lastAlertAt || (now - state.lastAlertAt) >= ALERT_COOLDOWN_MS;
    const shouldAlert = dueByStreak && (!state.alerted || cooledDown);

    if (shouldAlert) {
        await sendSmsAlert(`Roz: MySQL write failed (${state.failStreak} min)`);
        state.alerted = true;
        state.lastAlertAt = now;
    } else {
        console.log(`DB write fail streak=${state.failStreak} (alert deferred)`);
    }
}

module.exports = {
    sendSmsAlert,
    recordMonitorDbHealth,
};
