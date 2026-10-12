const admin = require('firebase-admin');
const db = require('./db');

let initialized = false;

function initFirebase() {
    if (initialized) {
        return true;
    }
    const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!json) {
        console.warn('FCM: FIREBASE_SERVICE_ACCOUNT_JSON not set, push disabled');
        return false;
    }
    try {
        const serviceAccount = JSON.parse(json);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
        initialized = true;
        return true;
    } catch (error) {
        console.error('FCM: failed to initialize firebase-admin:', error.message);
        return false;
    }
}

/**
 * @param {{ gridPresent: boolean, chargePercent: number|null, timestamp: string, notifyGridChange?: boolean }} payload
 */
async function sendPowerStatusPush({ gridPresent, chargePercent, timestamp, notifyGridChange = false }) {
    if (!initFirebase()) {
        return { sent: 0, failed: 0, skipped: true };
    }

    const tokens = await db.getAllFcmTokens();
    if (!tokens.length) {
        console.log('FCM: no registered tokens, skip push');
        return { sent: 0, failed: 0, skipped: true };
    }

    const data = {
        type: 'power_status',
        grid_present: gridPresent ? '1' : '0',
        charge_percent: chargePercent != null ? String(Math.round(chargePercent)) : '',
        timestamp: timestamp || new Date().toISOString(),
        notify_grid: notifyGridChange ? '1' : '0',
    };

    const message = {
        data,
        android: {
            // high только когда телефон показывает уведомление (смена сети); тихие обновления заряда — normal,
            // иначе Android снижает приоритет приложения за high без уведомления.
            priority: notifyGridChange ? 'high' : 'normal',
            ttl: (notifyGridChange ? 30 : 10) * 60 * 1000,
        },
        tokens,
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    const invalidTokens = [];

    response.responses.forEach((item, index) => {
        if (!item.success) {
            const code = item.error && item.error.code;
            if (
                code === 'messaging/registration-token-not-registered' ||
                code === 'messaging/invalid-registration-token'
            ) {
                invalidTokens.push(tokens[index]);
            }
            console.warn(`FCM: token send failed: ${code || item.error?.message}`);
        }
    });

    for (const token of invalidTokens) {
        await db.removeFcmToken(token);
    }

    const reason = notifyGridChange ? 'grid change' : 'charge update';
    console.log(
        `FCM: ${reason} push sent=${response.successCount} failed=${response.failureCount} grid=${gridPresent ? 'on' : 'off'} charge=${data.charge_percent || 'n/a'}`
    );

    return {
        sent: response.successCount,
        failed: response.failureCount,
        skipped: false,
    };
}

/**
 * Тихий data-only пуш «графики отключений изменились» — без notification-блока, приложение само обновит виджет.
 * Приоритет normal: high-priority data без показа UI Android может понижать; collapseKey — схлопывает очередь.
 * @param {{ group: string, date: string, hash: string }} payload
 */
async function sendScheduleUpdatePush({ group, date, hash, text = '', changes = [] }) {
    if (!initFirebase()) {
        return { sent: 0, failed: 0, skipped: true };
    }
    const tokens = await db.getAllFcmTokens();
    if (!tokens.length) {
        console.log('FCM: no registered tokens, skip schedule push');
        return { sent: 0, failed: 0, skipped: true };
    }
    const message = {
        data: {
            type: 'schedule_update',
            group: String(group || ''),
            date: String(date || ''),
            hash: String(hash || '').slice(0, 12),
            // «Сегодня: было 18:00–22:00 → стало 17:00–20:30» (строки через \n) + структура (JSON); лимит FCM data — 4 КБ
            text: String(text || '').slice(0, 1200),
            changes: (() => { const j = JSON.stringify(changes || []); return j.length <= 2000 ? j : '[]'; })(),
            timestamp: new Date().toISOString(),
        },
        android: {
            priority: 'high',   // всегда показывается уведомлением
            collapseKey: 'schedule_update',
            ttl: 6 * 3600 * 1000,
        },
        tokens,
    };
    const response = await admin.messaging().sendEachForMulticast(message);
    await cleanupInvalidTokens(response, tokens);
    return { sent: response.successCount, failed: response.failureCount, skipped: false };
}

async function cleanupInvalidTokens(response, tokens) {
    const invalidTokens = [];
    response.responses.forEach((item, index) => {
        if (!item.success) {
            const code = item.error && item.error.code;
            if (
                code === 'messaging/registration-token-not-registered' ||
                code === 'messaging/invalid-registration-token'
            ) {
                invalidTokens.push(tokens[index]);
            }
            console.warn(`FCM: token send failed: ${code || item.error?.message}`);
        }
    });
    for (const token of invalidTokens) {
        await db.removeFcmToken(token);
    }
}

/**
 * Тревоги по Киеву (alertPush.js): data-сообщение, звук/канал выбирает телефон.
 * @param {{ type: string } & Record<string,string>} payload  type: ballistic_start|ballistic_end|alert_drone|alert_missile|alert_end
 */
async function sendAlertPush(payload) {
    if (!initFirebase()) {
        return { sent: 0, failed: 0, skipped: true };
    }
    const tokens = await db.getAllFcmTokens();
    if (!tokens.length) {
        return { sent: 0, failed: 0, skipped: true };
    }
    const data = { timestamp: new Date().toISOString() };
    for (const [k, v] of Object.entries(payload || {})) {
        if (v != null) data[k] = String(v);
    }
    const isEnd = /_end$/.test(data.type || '');
    const message = {
        data,
        android: {
            priority: 'high',
            ttl: (isEnd ? 30 : 10) * 60 * 1000,   // устаревшая тревога не нужна
        },
        tokens,
    };
    const response = await admin.messaging().sendEachForMulticast(message);
    await cleanupInvalidTokens(response, tokens);
    return { sent: response.successCount, failed: response.failureCount, skipped: false };
}

/** @deprecated use sendPowerStatusPush with notifyGridChange: true */
async function sendGridChangeNotification(payload) {
    return sendPowerStatusPush({ ...payload, notifyGridChange: true });
}

module.exports = {
    sendPowerStatusPush,
    sendScheduleUpdatePush,
    sendAlertPush,
    sendGridChangeNotification,
};
