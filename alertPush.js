/**
 * FCM data-пуши о тревогах по Киеву: ballistic_start / ballistic_end, alert_drone / alert_missile / alert_end.
 * Источник: https://samber.in.ua/yasno/alert.php (агрегатор yasno: ukrainealarm + Kyiv Digital + alerts.in.ua + NEPTUN + @kpszsu, с кэшем).
 * Вызывается из POST /monitor (Cloud Scheduler, раз в минуту). Состояние хранится в MySQL (alert_push_state),
 * чтобы рестарт инстанса не давал повторных пушей. ALERT_PUSH_ENABLED=0 — выключить.
 *
 * Правила:
 *  - старт (тревога / баллистика) — сразу при первом увидании;
 *  - конец — только после ALERT_END_POLLS (по умолчанию 2) подряд «чистых» опросов (дебаунс мигания источников);
 *  - баллистика «?» (neptun / pszsu) → «подтверждена» (kd / ain) — повторный ballistic_start с upgrade=1;
 *  - смена дроны ↔ ракеты во время тревоги — alert_drone / alert_missile с change=1;
 *  - первая запись состояния (после деплоя) — без пуша;
 *  - ошибка загрузки источника — состояние не трогаем.
 */
const axios = require('axios');

const SOURCE_URL = process.env.ALERT_SOURCE_URL || 'https://samber.in.ua/yasno/alert.php';
const END_POLLS = Math.max(1, parseInt(process.env.ALERT_END_POLLS || '2', 10) || 2);
const KEY = 'kyiv';

/** alert.php JSON → { ok, alert: 'none'|'drone'|'missile', bal: 'none'|'q'|'c', balSrc } */
function deriveState(j) {
    if (!j || j.ok !== true) return { ok: false };
    const alerts = Array.isArray(j.alerts) ? j.alerts : [];
    let alert = 'none';
    if (alerts.length) alert = j.uaRed ? 'missile' : 'drone';
    let bal = 'none';
    const src = j.ballisticSrc || null;
    if (j.ballistic && src) bal = (src === 'kd' || src === 'ain') ? 'c' : 'q';
    if (bal !== 'none' && alert === 'none') alert = 'missile'; // баллистика без официальной тревоги — всё равно «ракетная» сторона
    return { ok: true, alert, bal, balSrc: src };
}

/**
 * Чистая функция переходов. prev: {alert, bal, alertOff, balOff} | null.
 * → { next, events: [{type, data}] }
 */
function computeTransitions(prev, cur, endPolls = END_POLLS) {
    const blank = { alert: 'none', bal: 'none', alertOff: 0, balOff: 0 };
    if (!prev) return { next: { ...blank, alert: cur.alert, bal: cur.bal }, events: [], initialized: true };
    const next = { ...blank, ...prev };
    const events = [];

    // баллистика
    if (cur.bal !== 'none') {
        if (prev.bal === 'none') events.push({ type: 'ballistic_start', data: { confirmed: cur.bal === 'c' ? '1' : '0', source: cur.balSrc || '' } });
        else if (prev.bal === 'q' && cur.bal === 'c') events.push({ type: 'ballistic_start', data: { confirmed: '1', upgrade: '1', source: cur.balSrc || '' } });
        next.bal = prev.bal === 'c' ? 'c' : cur.bal;
        next.balOff = 0;
    } else if (prev.bal !== 'none') {
        next.balOff = (prev.balOff || 0) + 1;
        if (next.balOff >= endPolls) {
            events.push({ type: 'ballistic_end', data: { confirmed: prev.bal === 'c' ? '1' : '0' } });
            next.bal = 'none';
            next.balOff = 0;
        }
    }

    // воздушная тревога
    if (cur.alert !== 'none') {
        if (prev.alert === 'none') events.push({ type: `alert_${cur.alert}`, data: {} });
        else if (prev.alert !== cur.alert) events.push({ type: `alert_${cur.alert}`, data: { change: '1' } });
        next.alert = cur.alert;
        next.alertOff = 0;
    } else if (prev.alert !== 'none') {
        next.alertOff = (prev.alertOff || 0) + 1;
        if (next.alertOff >= endPolls) {
            events.push({ type: 'alert_end', data: {} });
            next.alert = 'none';
            next.alertOff = 0;
        }
    }
    return { next, events, initialized: false };
}

function createMysqlAlertStateRepo(getPool) {
    let ensured = null;
    const pool = () => getPool();
    function ensure() {
        if (!ensured) {
            ensured = pool().query(
                `CREATE TABLE IF NOT EXISTS alert_push_state (
                    push_key VARCHAR(32) PRIMARY KEY,
                    state_json VARCHAR(512) NOT NULL,
                    updated_at DATETIME NOT NULL COMMENT 'UTC'
                )`
            ).catch((e) => { ensured = null; throw e; });
        }
        return ensured;
    }
    async function load(key) {
        await ensure();
        const [rows] = await pool().query('SELECT state_json FROM alert_push_state WHERE push_key = ?', [key]);
        if (!rows.length) return { exists: false, raw: null, state: null };
        let state = null;
        try { state = JSON.parse(rows[0].state_json); } catch (_) { state = null; }
        return { exists: true, raw: rows[0].state_json, state };
    }
    /** Оптимистичная запись: true, если удалось (никто не обновил строку между load и save). */
    async function save(key, prevRaw, next) {
        await ensure();
        const json = JSON.stringify(next);
        if (prevRaw == null) {
            const [r] = await pool().query(
                'INSERT IGNORE INTO alert_push_state (push_key, state_json, updated_at) VALUES (?, ?, UTC_TIMESTAMP())', [key, json]);
            return r.affectedRows > 0;
        }
        const [r] = await pool().query(
            'UPDATE alert_push_state SET state_json = ?, updated_at = UTC_TIMESTAMP() WHERE push_key = ? AND state_json = ?',
            [json, key, prevRaw]);
        return r.affectedRows > 0;
    }
    return { load, save };
}

function createAlertPushService({ stateRepo, sendPush, fetchJson }) {
    const fetcher = fetchJson || (async () => (await axios.get(SOURCE_URL, { timeout: 6000 })).data);
    async function check() {
        let cur;
        try {
            cur = deriveState(await fetcher());
        } catch (e) {
            return { skipped: 'fetch_error', error: e.message };
        }
        if (!cur.ok) return { skipped: 'source_not_ok' };
        const loaded = await stateRepo.load(KEY);
        const { next, events, initialized } = computeTransitions(loaded.state, cur);
        const saved = await stateRepo.save(KEY, loaded.exists ? loaded.raw : null, next);
        if (!saved) return { skipped: 'concurrent_update' };
        const sent = [];
        for (const ev of events) {
            try {
                const r = await sendPush({ type: ev.type, ...ev.data });
                sent.push({ type: ev.type, ...ev.data, sent: r && r.sent, failed: r && r.failed });
                console.log(`FCM: ${ev.type} ${JSON.stringify(ev.data)} sent=${r && r.sent} failed=${r && r.failed}`);
            } catch (e) {
                sent.push({ type: ev.type, error: e.message });
                console.error(`FCM: ${ev.type} failed: ${e.message}`);
            }
        }
        return { state: next, initialized: !!initialized, events: sent };
    }
    return { check };
}

module.exports = { deriveState, computeTransitions, createMysqlAlertStateRepo, createAlertPushService };
