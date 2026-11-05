/**
 * СвітлоБот (api.svitlobot.in.ua): сообщаем о наличии света по двум розеткам (ввод + кухня).
 *
 * Правила СвітлоБота:
 *  - channelPing ~раз в минуту, СТРОГО не чаще раза в 60 с (частые запросы с IP → бан).
 *    Интервал общий для всех инстансов Cloud Run: «захват» слота атомарным UPDATE в MySQL.
 *  - channelPingOff — один раз за отключение и только после надёжного подтверждения:
 *    2 опроса подряд без света: ОБЕ розетки 'off' (офлайн / недоступна ИЛИ напряжение < порога).
 *  - Запросы к API ТОЛЬКО при согласованных статусах обеих розеток:
 *    • Обе 'on' → channelPing (с дебаунсом 60 с)
 *    • Обе 'off' → channelPingOff (после 2 опросов подряд)
 *    • Несовпадение (включая 'unknown') → НИ ОДИН запрос, нет переходов состояния.
 *  - Несовпадение прерывает серию off_streak (дебаунс начинается заново).
 *
 * Без SVITLOBOT_CHANNEL_KEY модуль ничего не делает. Ключ в логи не пишется.
 * Ошибки никогда не пробрасываются наружу — основной опрос не ломается.
 */
const { GRID_VOLTAGE_THRESHOLD } = require('./gridPower');

const API_BASE = 'https://api.svitlobot.in.ua';
const USER_AGENT = 'power-monitor/1.0';
const TIMEOUT_MS = 6000;
const MIN_PING_INTERVAL_SEC = 60;
const OFF_CONFIRM_POLLS = 2;

let tableReady = false;

async function ensureTable(pool) {
    if (tableReady) return;
    await pool.execute(`CREATE TABLE IF NOT EXISTS svitlobot_state (
        id TINYINT PRIMARY KEY,
        last_ping_at DATETIME NULL COMMENT 'UTC: последний channelPing (захват слота)',
        off_streak INT NOT NULL DEFAULT 0 COMMENT 'опросов подряд без света (офлайн или V < порога)',
        off_sent TINYINT NOT NULL DEFAULT 0 COMMENT '1 = channelPingOff за это отключение уже отправлен',
        updated_at DATETIME NULL COMMENT 'UTC'
    )`);
    await pool.execute('INSERT IGNORE INTO svitlobot_state (id, off_streak, off_sent) VALUES (1, 0, 0)');
    tableReady = true;
}

/**
 * @returns {'on'|'off'|'unknown'} on = онлайн и V>=порога; off = офлайн/недоступна или V<порога; unknown = онлайн без напряжения
 */
function classifyReading(socketResult) {
    // Розетка офлайн / Tuya недоступна — считаем, что света нет (решение Олега).
    if (!socketResult || !socketResult.isOnline) return 'off';
    const v = socketResult.voltageV;
    if (v === null || v === undefined || Number.isNaN(Number(v))) return 'unknown';
    return Number(v) >= GRID_VOLTAGE_THRESHOLD ? 'on' : 'off';
}

/**
 * Агрегированная оценка: запросы к СвітлоБот только при согласованных статусах обеих розеток.
 * Обе 'on' → 'on'; обе 'off' → 'off'; любое несовпадение (включая 'unknown') → 'mismatch'.
 * @param {Array<'on'|'off'|'unknown'>} readings
 * @returns {'on'|'off'|'mismatch'}
 */
function aggregateReadings(readings) {
    if (!readings || readings.length === 0) return 'mismatch';
    if (readings.length < 2) return 'mismatch';
    const first = readings[0];
    if (readings.every(r => r === first && r === 'on')) return 'on';
    if (readings.every(r => r === first && r === 'off')) return 'off';
    return 'mismatch';
}

async function callApi(method, key, fetchImpl = fetch) {
    const url = `${API_BASE}/${method}?channel_key=${encodeURIComponent(key)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const res = await fetchImpl(url, { method: 'GET', headers: { 'User-Agent': USER_AGENT }, signal: ctrl.signal });
        return { ok: res.ok, status: res.status };
    } catch (e) {
        return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : e.message };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Вызывать после каждого опроса розеток.
 * @param {object} pool mysql2 pool
 * @param {object|undefined} inputSocketResult результат tuya.checkDeviceAvailability для розетки ввод
 * @param {object|undefined} kitchenSocketResult результат tuya.checkDeviceAvailability для розетки кухня
 */
async function reportToSvitlobot(pool, inputSocketResult, kitchenSocketResult, { key = process.env.SVITLOBOT_CHANNEL_KEY, fetchImpl } = {}) {
    if (!key || !String(key).trim()) return { skipped: 'no-key' };
    key = String(key).trim();
    try {
        await ensureTable(pool);
        
        const inputReading = classifyReading(inputSocketResult);
        const kitchenReading = classifyReading(kitchenSocketResult);
        const reading = aggregateReadings([inputReading, kitchenReading]);

        if (reading === 'on') {
            await pool.execute('UPDATE svitlobot_state SET off_streak = 0, off_sent = 0, updated_at = UTC_TIMESTAMP() WHERE id = 1');
            // Атомарный захват слота: только один инстанс и не чаще раза в 60 с.
            const [claim] = await pool.execute(
                `UPDATE svitlobot_state SET last_ping_at = UTC_TIMESTAMP()
                 WHERE id = 1 AND (last_ping_at IS NULL OR last_ping_at <= UTC_TIMESTAMP() - INTERVAL ${MIN_PING_INTERVAL_SEC} SECOND)`
            );
            if (!claim.affectedRows) return { inputReading, kitchenReading, reading, action: 'ping-throttled' };
            const r = await callApi('channelPing', key, fetchImpl);
            if (!r.ok) console.warn(`СвітлоБот channelPing не удался: status=${r.status}${r.error ? ` (${r.error})` : ''}`);
            return { inputReading, kitchenReading, reading, action: 'ping', ok: r.ok, status: r.status };
        }

        if (reading === 'off') {
            await pool.execute('UPDATE svitlobot_state SET off_streak = off_streak + 1, updated_at = UTC_TIMESTAMP() WHERE id = 1');
            const [claim] = await pool.execute(
                `UPDATE svitlobot_state SET off_sent = 1 WHERE id = 1 AND off_sent = 0 AND off_streak >= ${OFF_CONFIRM_POLLS}`
            );
            if (!claim.affectedRows) return { inputReading, kitchenReading, reading, action: 'off-wait-or-sent' };
            const r = await callApi('channelPingOff', key, fetchImpl);
            if (!r.ok) {
                // Вернём флаг — повторим на следующем опросе (если свет всё ещё нет).
                await pool.execute('UPDATE svitlobot_state SET off_sent = 0 WHERE id = 1');
                console.warn(`СвітлоБот channelPingOff не удался: status=${r.status}${r.error ? ` (${r.error})` : ''}`);
            } else {
                console.log('СвітлоБот: отправлен channelPingOff');
            }
            return { inputReading, kitchenReading, reading, action: 'ping-off', ok: r.ok, status: r.status };
        }

        // mismatch: несовпадение статусов — ничего не шлём, серию «нет света» прерываем.
        await pool.execute('UPDATE svitlobot_state SET off_streak = 0, updated_at = UTC_TIMESTAMP() WHERE id = 1');
        return { inputReading, kitchenReading, reading, action: 'mismatch' };
    } catch (e) {
        console.error('СвітлоБот: ошибка обработки:', e.message);
        return { error: e.message };
    }
}

module.exports = { reportToSvitlobot, classifyReading, aggregateReadings, callApi, MIN_PING_INTERVAL_SEC };
