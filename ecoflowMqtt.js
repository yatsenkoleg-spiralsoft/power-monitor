/**
 * «Пинок» облака EcoFlow через Open API MQTT.
 *
 * Почему: HTTP /iot-open/sign/device/quota/all отдаёт кэш облака, а станция шлёт в облако
 * свежие данные только пока кто-то «смотрит» её в реальном времени (открыто приложение
 * EcoFlow или есть активная MQTT-подписка). Без этого значения замерзают на часы:
 * 10.10 «Экофлошка» (DELTA 2 Max) показывала 100% с 10:44 до 21:22 и разморозилась ровно
 * когда открыли приложение EcoFlow. Известная проблема API:
 *   https://github.com/tolwi/hassio-ecoflow-cloud/issues/57
 *   https://github.com/berezhinskiy/ecoflow_exporter/issues/67
 *
 * Что делаем: раз в ECOFLOW_MQTT_KICK_INTERVAL_MIN минут (по умолчанию 10) коротко подключаемся к MQTT
 * (учётка из GET /iot-open/sign/certification — только чтение), подписываемся на
 * /open/<account>/<sn>/quota, несколько секунд собираем сообщения и отключаемся.
 * Переподписка «будит» поток данных (как открытие приложения), а пришедшие значения сразу
 * накладываем поверх HTTP-ответа. Никаких команд устройству не отправляется (нет publish).
 */

let mqttLib = null;
function getMqtt() {
    if (mqttLib === null) {
        try {
            mqttLib = require('mqtt');
        } catch (e) {
            console.warn('EcoFlow MQTT: пакет mqtt не установлен —', e.message);
            mqttLib = false;
        }
    }
    return mqttLib || null;
}

const CREDS_TTL_MS = 6 * 3600 * 1000;
// Как часто «будить» облако (подписка ~4 с). По умолчанию раз в 10 минут; env ECOFLOW_MQTT_KICK_INTERVAL_MIN.
const KICK_INTERVAL_MIN = Number(process.env.ECOFLOW_MQTT_KICK_INTERVAL_MIN);
const KICK_MIN_INTERVAL_MS = (Number.isFinite(KICK_INTERVAL_MIN) && KICK_INTERVAL_MIN > 0 ? KICK_INTERVAL_MIN : 10) * 60 * 1000 - 10 * 1000;
const DEFAULT_WAIT_MS = Number(process.env.ECOFLOW_MQTT_WAIT_MS) || 4000;

let credsCache = { creds: null, at: 0 };
let lastKickAt = 0;
let inFlight = null;

// typeCode из сообщений Open API → префикс ключей как в /quota/all
const TYPECODE_PREFIX = {
    pdStatus: 'pd.',
    bmsStatus: 'bms_bmsStatus.',
    emsStatus: 'bms_emsStatus.',
    invStatus: 'inv.',
    mpptStatus: 'mppt.',
};

/**
 * Превращает сообщение из MQTT-топика quota в плоские ключи формата /quota/all.
 * Возвращает {} если формат не распознан (тогда просто ничего не накладываем).
 */
function flattenQuotaMessage(msg) {
    const out = {};
    if (!msg || typeof msg !== 'object') return out;
    const params = msg.params && typeof msg.params === 'object' ? msg.params : (msg.param && typeof msg.param === 'object' ? msg.param : null);
    if (!params) return out;
    const prefix = TYPECODE_PREFIX[msg.typeCode] || null;
    for (const [k, v] of Object.entries(params)) {
        if (v === null || v === undefined || typeof v === 'object') continue;
        if (k.includes('.')) {
            out[k] = v; // уже в формате quota/all (например, "pd.soc")
        } else if (prefix) {
            out[prefix + k] = v;
        }
    }
    return out;
}

function maskSn(sn) {
    const s = String(sn || '');
    return s.length > 7 ? `${s.slice(0, 4)}…${s.slice(-3)}` : s;
}

async function getCredentials(restClient, { force = false } = {}) {
    const now = Date.now();
    if (!force && credsCache.creds && now - credsCache.at < CREDS_TTL_MS) return credsCache.creds;
    const c = await restClient.getMqttCredentials();
    if (!c || !c.certificateAccount || !c.certificatePassword || !c.url) {
        throw new Error('certification: incomplete response');
    }
    credsCache = { creds: c, at: now };
    return c;
}

function isAuthError(err) {
    const msg = String((err && err.message) || err || '');
    return /not authori[sz]ed|bad user ?name or password|auth/i.test(msg) || (err && (err.code === 5 || err.code === 4 || err.code === 134 || err.code === 135));
}

/**
 * Stable clientId: EcoFlow expects a clientId tied to certificateAccount; a new random id on every kick
 * (144+/day) may hit the broker's per-account client limit. Override: ECOFLOW_MQTT_CLIENT_ID.
 */
function buildClientId(account, override = process.env.ECOFLOW_MQTT_CLIENT_ID) {
    if (override) return String(override);
    return `${account}_roz-pm`;
}

/** Back-off after consecutive auth failures: 10, 20, 40 min ... up to 6 h. */
function authBackoffMs(streak, baseMs = KICK_MIN_INTERVAL_MS) {
    if (!streak || streak <= 0) return 0;
    return Math.min(baseMs * 2 ** (streak - 1), 6 * 3600 * 1000);
}

let authFailStreak = 0;
let authBlockedUntil = 0;

async function connectAndCollect(mqtt, creds, sns, waitMs, result) {
    const protocol = creds.protocol || 'mqtts';
    const url = `${protocol}://${creds.url}:${creds.port || 8883}`;
    const account = creds.certificateAccount;
    const topicToSn = new Map(sns.map((sn) => [`/open/${account}/${sn}/quota`, sn]));
    const counts = new Map(sns.map((sn) => [sn, 0]));
    let client = null;
    try {
        client = mqtt.connect(url, {
            username: account,
            password: creds.certificatePassword,
            clientId: buildClientId(account),
            clean: true,
            reconnectPeriod: 0,
            connectTimeout: 5000,
            keepalive: 30,
        });
        client.on('message', (topic, payload) => {
            const sn = topicToSn.get(topic);
            if (!sn) return;
            counts.set(sn, (counts.get(sn) || 0) + 1);
            try {
                const flat = flattenQuotaMessage(JSON.parse(payload.toString('utf8')));
                if (Object.keys(flat).length) result.set(sn, { ...(result.get(sn) || {}), ...flat });
            } catch (_) { /* not JSON (protobuf etc.) - skip */ }
        });
        await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('connect timeout')), 6000);
            client.once('connect', () => { clearTimeout(t); resolve(); });
            client.once('error', (e) => { clearTimeout(t); reject(e); });
        });
        await new Promise((resolve, reject) => {
            client.subscribe([...topicToSn.keys()], { qos: 1 }, (err) => (err ? reject(err) : resolve()));
        });
        await new Promise((r) => setTimeout(r, waitMs));
        console.log('EcoFlow MQTT: ' + sns.map((sn) => `${maskSn(sn)} msgs=${counts.get(sn) || 0} keys=${Object.keys(result.get(sn) || {}).length}`).join(', '));
    } finally {
        if (client) {
            try { client.end(true); } catch (_) { /* ignore */ }
        }
    }
}

/**
 * Short MQTT session to wake the cloud quota: connect, subscribe, collect for waitMs, disconnect.
 * On auth failure: re-fetch certification (drop cache) and retry once; if still refused, back off.
 * @returns {Promise<Map<string, Record<string, any>>>}
 */
async function kickAndCollect(restClient, sns, { waitMs = DEFAULT_WAIT_MS, force = false } = {}) {
    const result = new Map();
    if (process.env.ECOFLOW_MQTT_KICK === '0') return result;
    if (!Array.isArray(sns) || sns.length === 0) return result;
    const mqtt = getMqtt();
    if (!mqtt) return result;

    const now = Date.now();
    if (inFlight) return inFlight;
    if (!force && now - lastKickAt < KICK_MIN_INTERVAL_MS) return result;
    if (!force && now < authBlockedUntil) return result;
    lastKickAt = now;

    inFlight = (async () => {
        try {
            const creds = await getCredentials(restClient);
            try {
                await connectAndCollect(mqtt, creds, sns, waitMs, result);
            } catch (err) {
                if (!isAuthError(err)) throw err;
                console.warn(`EcoFlow MQTT: auth refused (${err.message}), re-fetching certification and retrying once`);
                credsCache = { creds: null, at: 0 };
                const fresh = await getCredentials(restClient, { force: true });
                await connectAndCollect(mqtt, fresh, sns, waitMs, result);
                console.log('EcoFlow MQTT: reconnected with fresh certification');
            }
            if (authFailStreak) console.log(`EcoFlow MQTT: auth OK again after ${authFailStreak} failed kicks`);
            authFailStreak = 0;
            authBlockedUntil = 0;
        } catch (err) {
            if (isAuthError(err)) {
                credsCache = { creds: null, at: 0 };
                authFailStreak += 1;
                const backoff = authBackoffMs(authFailStreak);
                authBlockedUntil = Date.now() + backoff;
                console.warn(`EcoFlow MQTT kick failed: ${err.message} (even with fresh certification); streak=${authFailStreak}, next try in ${Math.round(backoff / 60000)} min`);
            } else {
                console.warn('EcoFlow MQTT kick failed:', err && err.message);
            }
        } finally {
            inFlight = null;
        }
        return result;
    })();
    return inFlight;
}

module.exports = { kickAndCollect, flattenQuotaMessage, maskSn, isAuthError, buildClientId, authBackoffMs };
