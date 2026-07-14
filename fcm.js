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
            priority: 'high',
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

/** @deprecated use sendPowerStatusPush with notifyGridChange: true */
async function sendGridChangeNotification(payload) {
    return sendPowerStatusPush({ ...payload, notifyGridChange: true });
}

module.exports = {
    sendPowerStatusPush,
    sendGridChangeNotification,
};
