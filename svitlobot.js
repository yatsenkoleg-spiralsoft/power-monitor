/**
 * СвітлоБот (api.svitlobot.in.ua): сообщаем о наличии света по двум розеткам (ввод + кухня).
 *
 * Правила СвітлоБота:
 *  - channelPing ~раз в минуту, СТРОГО не чаще раза в 60 с (частые запросы с IP → бан).
 *    Интервал общий для всех инстансов Cloud Run: «захват» слота атомарным UPDATE в MySQL.
 *  - channelPingOff — один раз за отключение, при первом же опросе с «обе офлайн».
 *  - Логика определения света ПО СВЯЗИ С УСТРОЙСТВАМИ (не по напряжению/мощности):
 *    • Хотя бы ОДНА розетка онлайн (isOnline=true) → свет есть → channelPing
 *      (даже если реле выключено или выход 0В/0Вт — важна связь с устройством)
 *    • ОБЕ розетки офлайн (isOnline=false) И хотя бы ОДНО реле-свидетель онлайн → 
 *      света нет → channelPingOff сразу (свидетель доказывает, что интернет работает)
 *    • ОБЕ розетки офлайн БЕЗ онлайн-свидетеля → неопределённость (возможна перезагрузка роутера),
 *      НЕ шлём PingOff
 *    • Unknown/ошибки API/неполные данные НЕ синтезируют "обе офлайн"
 *  - Реле-свидетели интернет-связи (kitchen light / corridor light): их онлайн-статус
 *    (не switch on/off) доказывает работу интернета при «обе розетки офлайн».
 *
 * Без SVITLOBOT_CHANNEL_KEY модуль ничего не делает. Ключ в логи не пишется.
 * Ошибки никогда не пробрасываются наружу — основной опрос не ломается.
 */

const API_BASE = 'https://api.svitlobot.in.ua';
const USER_AGENT = 'power-monitor/1.0';
const TIMEOUT_MS = 6000;
const MIN_PING_INTERVAL_SEC = 60;

let tableReady = false;

async function ensureTable(pool) {
    if (tableReady) return;
    await pool.execute(`CREATE TABLE IF NOT EXISTS svitlobot_state (
        id TINYINT PRIMARY KEY,
        last_ping_at DATETIME NULL COMMENT 'UTC: последний channelPing (захват слота)',
        off_sent TINYINT NOT NULL DEFAULT 0 COMMENT '1 = channelPingOff за это отключение уже отправлен',
        updated_at DATETIME NULL COMMENT 'UTC'
    )`);
    await pool.execute('INSERT IGNORE INTO svitlobot_state (id, off_sent) VALUES (1, 0)');
    tableReady = true;
}

/**
 * Агрегированная оценка ПО СВЯЗИ С УСТРОЙСТВАМИ (не по напряжению/мощности).
 * @param {object|undefined} inputSocketResult результат checkDeviceAvailability для розетки ввод
 * @param {object|undefined} kitchenSocketResult результат checkDeviceAvailability для розетки кухня
 * @param {object|undefined} kitchenLightResult результат для света на кухне (witness)
 * @param {object|undefined} corridorLightResult результат для света в коридоре (witness)
 * @returns {'on'|'off'|'unknown'}
 */
function aggregateReadings(inputSocketResult, kitchenSocketResult, kitchenLightResult, corridorLightResult) {
    const inputOnline = inputSocketResult && inputSocketResult.isOnline === true;
    const kitchenOnline = kitchenSocketResult && kitchenSocketResult.isOnline === true;
    
    // Хотя бы ОДНА розетка онлайн → свет есть (даже если реле выключено или 0В/0Вт)
    if (inputOnline || kitchenOnline) return 'on';
    
    // ОБЕ розетки ЯВНО офлайн (isOnline=false)
    const inputOffline = inputSocketResult && inputSocketResult.isOnline === false;
    const kitchenOffline = kitchenSocketResult && kitchenSocketResult.isOnline === false;
    if (inputOffline && kitchenOffline) {
        // Проверяем свидетелей: хотя бы одно реле онлайн → интернет работает, света действительно нет
        const kitchenLightOnline = kitchenLightResult && kitchenLightResult.isOnline === true;
        const corridorLightOnline = corridorLightResult && corridorLightResult.isOnline === true;
        if (kitchenLightOnline || corridorLightOnline) return 'off';
        
        // ОБЕ розетки офлайн, НО нет онлайн-свидетеля → неопределённость (возможна перезагрузка роутера)
        return 'unknown';
    }
    
    // Всё остальное (undefined, null, ошибки API, неполные данные) → unknown
    return 'unknown';
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
 * @param {object|undefined} kitchenLightResult результат для света на кухне (witness)
 * @param {object|undefined} corridorLightResult результат для света в коридоре (witness)
 */
async function reportToSvitlobot(pool, inputSocketResult, kitchenSocketResult, kitchenLightResult, corridorLightResult, { key = process.env.SVITLOBOT_CHANNEL_KEY, fetchImpl } = {}) {
    if (!key || !String(key).trim()) return { skipped: 'no-key' };
    key = String(key).trim();
    try {
        await ensureTable(pool);
        
        const reading = aggregateReadings(inputSocketResult, kitchenSocketResult, kitchenLightResult, corridorLightResult);
        const inputOnline = inputSocketResult && inputSocketResult.isOnline === true;
        const kitchenOnline = kitchenSocketResult && kitchenSocketResult.isOnline === true;
        const witnessOnline = (kitchenLightResult && kitchenLightResult.isOnline === true) || 
                              (corridorLightResult && corridorLightResult.isOnline === true);

        if (reading === 'on') {
            await pool.execute('UPDATE svitlobot_state SET off_sent = 0, updated_at = UTC_TIMESTAMP() WHERE id = 1');
            // Атомарный захват слота: только один инстанс и не чаще раза в 60 с.
            const [claim] = await pool.execute(
                `UPDATE svitlobot_state SET last_ping_at = UTC_TIMESTAMP()
                 WHERE id = 1 AND (last_ping_at IS NULL OR last_ping_at <= UTC_TIMESTAMP() - INTERVAL ${MIN_PING_INTERVAL_SEC} SECOND)`
            );
            if (!claim.affectedRows) return { inputOnline, kitchenOnline, witnessOnline, reading, action: 'ping-throttled' };
            const r = await callApi('channelPing', key, fetchImpl);
            if (!r.ok) console.warn(`СвітлоБот channelPing не удался: status=${r.status}${r.error ? ` (${r.error})` : ''}`);
            return { inputOnline, kitchenOnline, witnessOnline, reading, action: 'ping', ok: r.ok, status: r.status };
        }

        if (reading === 'off') {
            // ОБЕ розетки офлайн И есть онлайн-свидетель → отправляем PingOff (если ещё не отправлен)
            const [claim] = await pool.execute(
                'UPDATE svitlobot_state SET off_sent = 1, updated_at = UTC_TIMESTAMP() WHERE id = 1 AND off_sent = 0'
            );
            if (!claim.affectedRows) return { inputOnline, kitchenOnline, witnessOnline, reading, action: 'off-already-sent' };
            const r = await callApi('channelPingOff', key, fetchImpl);
            if (!r.ok) {
                // Вернём флаг — повторим на следующем опросе (если свет всё ещё нет).
                await pool.execute('UPDATE svitlobot_state SET off_sent = 0 WHERE id = 1');
                console.warn(`СвітлоБот channelPingOff не удался: status=${r.status}${r.error ? ` (${r.error})` : ''}`);
            } else {
                console.log('СвітлоБот: отправлен channelPingOff');
            }
            return { inputOnline, kitchenOnline, witnessOnline, reading, action: 'ping-off', ok: r.ok, status: r.status };
        }

        // unknown: ошибки API, неполные данные, или обе розетки офлайн без свидетеля — ничего не шлём
        return { inputOnline, kitchenOnline, witnessOnline, reading, action: 'none' };
    } catch (e) {
        console.error('СвітлоБот: ошибка обработки:', e.message);
        return { error: e.message };
    }
}

module.exports = { reportToSvitlobot, aggregateReadings, callApi, MIN_PING_INTERVAL_SEC };
