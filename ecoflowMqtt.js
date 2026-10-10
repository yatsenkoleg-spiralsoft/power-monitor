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
 * Что делаем: на каждом опросе (не чаще KICK_MIN_INTERVAL_MS) коротко подключаемся к MQTT
 * (учётка из GET /iot-open/sign/certification — только чтение), подписываемся на
 * /open/<account>/<sn>/quota, несколько секунд собираем сообщения и отключаемся.
 * Переподписка «будит» поток данных (как открытие приложения), а пришедшие значения сразу
 * накладываем поверх HTTP-ответа. Никаких команд устройству не отправляется (нет publish).
 */
const crypto = require('crypto');

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
const KICK_MIN_INTERVAL_MS = 50 * 1000;
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

async function getCredentials(restClient) {
    const now = Date.now();
    if (credsCache.creds && now - credsCache.at < CREDS_TTL_MS) return credsCache.creds;
    const c = await restClient.getMqttCredentials();
    if (!c || !c.certificateAccount || !c.certificatePassword || !c.url) {
        throw new Error('certification: неполный ответ');
    }
    credsCache = { creds: c, at: now };
    return c;
}

/**
 * Подключиться, подписаться на quota всех станций, собрать сообщения waitMs, отключиться.
 * Никогда не бросает исключений.
 * @returns {Promise<Map<string, Record<string, any>>>} sn -> свежие ключи (может быть пустой)
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
    lastKickAt = now;

    inFlight = (async () => {
        let client = null;
        try {
            const creds = await getCredentials(restClient);
            const protocol = creds.protocol || 'mqtts';
            const url = `${protocol}://${creds.url}:${creds.port || 8883}`;
            const account = creds.certificateAccount;
            const topicToSn = new Map(sns.map((sn) => [`/open/${account}/${sn}/quota`, sn]));
            const counts = new Map(sns.map((sn) => [sn, 0]));

            client = mqtt.connect(url, {
                username: account,
                password: creds.certificatePassword,
                clientId: `roz-pm-${crypto.randomBytes(6).toString('hex')}`,
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
                    if (Object.keys(flat).length) {
                        result.set(sn, { ...(result.get(sn) || {}), ...flat });
                    }
                } catch (_) { /* не JSON (protobuf у части моделей) — достаточно самого «пинка» */ }
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
        } catch (err) {
            console.warn('EcoFlow MQTT kick не удался:', err && err.message);
            if (/auth|not authorized|bad user/i.test(String(err && err.message))) credsCache = { creds: null, at: 0 };
        } finally {
            if (client) {
                try { client.end(true); } catch (_) { /* ignore */ }
            }
            inFlight = null;
        }
        return result;
    })();
    return inFlight;
}

module.exports = { kickAndCollect, flattenQuotaMessage, maskSn };
