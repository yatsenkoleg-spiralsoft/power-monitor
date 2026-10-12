/**
 * Тихий FCM-пуш при появлении/изменении графика отключений (сегодня + завтра) — чтобы виджет перечитал графики.
 *
 * «Эффективный» график на день — как в приложении/roz (schedFor): YASNO, если у него есть слоты или он не в режиме
 * ожидания/аварийных; иначе ДТЭК. Аварийный режим (EmergencyShutdowns у YASNO) тоже входит в хеш.
 * Хеш хранится в БД (schedule_push_state), поэтому рестарт/несколько инстансов Cloud Run не шлют повторно.
 * Дебаунс: не чаще одного пуша в debounceMinutes; пропущенное изменение уйдёт при следующем опросе.
 */
const crypto = require('crypto');
const { kyivDateKey, addDays } = require('./schedules');
const { describeScheduleChange } = require('./scheduleDiff');

const isWaiting = (st) => /Waiting|NoSchedule/i.test(st || '');
const isEmergency = (st) => /Emergency/i.test(st || '');

/** days — объект `days` из scheduleService.query(); dates — ['YYYY-MM-DD', ...] */
function effectiveDays(days, dates) {
    return dates.map((date) => {
        const d = (days && days[date]) || {};
        const y = d.yasno, t = d.dtek;
        let use = null, source = null;
        if (y && ((y.slots || []).length || (!isWaiting(y.status) && !isEmergency(y.status)))) { use = y; source = 'yasno'; }
        else if (t && (t.slots || []).length) { use = t; source = 'dtek'; }
        else if (y) { use = y; source = 'yasno'; }
        else if (t) { use = t; source = 'dtek'; }
        return {
            date,
            source,
            status: use ? use.status || null : null,
            emergency: !!(y && isEmergency(y.status)),
            slots: use ? (use.slots || []).map((s) => [s.start, s.end, s.type]) : [],
        };
    });
}

function effectiveHash(eff) {
    return crypto.createHash('sha1').update(JSON.stringify(eff)).digest('hex');
}

/** MySQL-состояние пушей. Таблица создаётся сама (CREATE TABLE IF NOT EXISTS), миграция 006 — то же вручную. */
function createMysqlPushStateRepo(getPool) {
    let ensured = null;
    const pool = () => getPool();
    function ensure() {
        if (!ensured) {
            ensured = pool().query(
                `CREATE TABLE IF NOT EXISTS schedule_push_state (
                    push_key VARCHAR(32) PRIMARY KEY COMMENT 'schedule:<группа>',
                    content_hash CHAR(40) NOT NULL COMMENT 'sha1 эффективного графика сегодня+завтра',
                    last_push_at DATETIME NULL COMMENT 'UTC: последний отправленный пуш',
                    updated_at DATETIME NOT NULL COMMENT 'UTC'
                )`
            ).catch((e) => { ensured = null; throw e; });
        }
        return ensured;
    }

    // снимок эффективного графика на момент последнего пуша — для текста «было → стало»
    let ensuredSnap = null;
    function ensureSnap() {
        if (!ensuredSnap) {
            ensuredSnap = pool().query(
                `CREATE TABLE IF NOT EXISTS schedule_push_snapshot (
                    push_key VARCHAR(32) PRIMARY KEY,
                    eff_json MEDIUMTEXT NOT NULL,
                    updated_at DATETIME NOT NULL COMMENT 'UTC'
                )`
            ).catch((e) => { ensuredSnap = null; throw e; });
        }
        return ensuredSnap;
    }
    async function getSnapshot(key) {
        await ensureSnap();
        const [rows] = await pool().query('SELECT eff_json FROM schedule_push_snapshot WHERE push_key = ?', [key]);
        if (!rows.length) return null;
        try { return JSON.parse(rows[0].eff_json); } catch (_) { return null; }
    }
    async function saveSnapshot(key, eff) {
        await ensureSnap();
        await pool().query(
            `INSERT INTO schedule_push_snapshot (push_key, eff_json, updated_at) VALUES (?, ?, UTC_TIMESTAMP())
             ON DUPLICATE KEY UPDATE eff_json = VALUES(eff_json), updated_at = UTC_TIMESTAMP()`,
            [key, JSON.stringify(eff)]);
    }

    /**
     * Атомарно «забирает» право на пуш. → { claimed: bool, reason: 'initialized'|'unchanged'|'debounced'|null }
     * Первая запись (нет строки) только сохраняет хеш — без пуша, чтобы деплой не будил все телефоны.
     */
    async function claimPush(key, hash, debounceMinutes) {
        await ensure();
        const [ins] = await pool().query(
            `INSERT IGNORE INTO schedule_push_state (push_key, content_hash, last_push_at, updated_at)
             VALUES (?, ?, NULL, UTC_TIMESTAMP())`, [key, hash]
        );
        if (ins.affectedRows > 0) return { claimed: false, reason: 'initialized' };
        const [upd] = await pool().query(
            `UPDATE schedule_push_state
                SET content_hash = ?, last_push_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP()
              WHERE push_key = ? AND content_hash <> ?
                AND (last_push_at IS NULL OR last_push_at < UTC_TIMESTAMP() - INTERVAL ? MINUTE)`,
            [hash, key, hash, Math.max(0, Math.round(debounceMinutes))]
        );
        if (upd.affectedRows > 0) return { claimed: true, reason: null };
        const [rows] = await pool().query(`SELECT content_hash FROM schedule_push_state WHERE push_key = ?`, [key]);
        return { claimed: false, reason: rows[0] && rows[0].content_hash === hash ? 'unchanged' : 'debounced' };
    }

    return { claimPush, getSnapshot, saveSnapshot };
}

/** In-memory вариант (тесты). */
function createMemoryPushStateRepo(clock = () => new Date()) {
    const state = {};
    const snaps = {};
    return {
        state,
        snaps,
        async getSnapshot(key) { return snaps[key] ? JSON.parse(snaps[key]) : null; },
        async saveSnapshot(key, eff) { snaps[key] = JSON.stringify(eff); },
        async claimPush(key, hash, debounceMinutes) {
            const s = state[key];
            if (!s) { state[key] = { hash, lastPushAt: null }; return { claimed: false, reason: 'initialized' }; }
            if (s.hash === hash) return { claimed: false, reason: 'unchanged' };
            const t = clock().getTime();
            if (s.lastPushAt && t - s.lastPushAt < debounceMinutes * 60000) return { claimed: false, reason: 'debounced' };
            s.hash = hash; s.lastPushAt = t;
            return { claimed: true, reason: null };
        },
    };
}

function createSchedulePushService({
    scheduleService,
    stateRepo,
    sendPush,                                   // async ({ group, date, hash }) => { sent, failed, skipped }
    group = process.env.SCHEDULE_PUSH_GROUP || process.env.SCHEDULE_DEFAULT_GROUP || '49.1',
    debounceMinutes = parseInt(process.env.SCHEDULE_PUSH_DEBOUNCE_MINUTES || '5', 10),
    now = () => new Date(),
    log = console,
} = {}) {
    if (!scheduleService || !stateRepo || !sendPush) throw new Error('schedulePush: scheduleService, stateRepo, sendPush обязательны');

    async function check() {
        const today = kyivDateKey(now());
        const tomorrow = addDays(today, 1);
        const q = await scheduleService.query({ group, startDate: today, endDate: tomorrow });
        const eff = effectiveDays(q.days, [today, tomorrow]);
        const hash = effectiveHash(eff);
        const key = `schedule:${group}`;
        const claim = await stateRepo.claimPush(key, hash, debounceMinutes);
        const hasSnap = typeof stateRepo.getSnapshot === 'function' && typeof stateRepo.saveSnapshot === 'function';
        if (!claim.claimed) {
            if (claim.reason === 'initialized' && hasSnap) {
                try { await stateRepo.saveSnapshot(key, eff); } catch (e) { log.error && log.error('schedule snapshot:', e.message); }
            }
            return { pushed: false, reason: claim.reason, hash: hash.slice(0, 12) };
        }
        let change = { text: '', days: [] };
        if (hasSnap) {
            try {
                const prev = await stateRepo.getSnapshot(key);
                if (prev) change = describeScheduleChange(prev, eff, { [today]: 'Сегодня', [tomorrow]: 'Завтра' });
                await stateRepo.saveSnapshot(key, eff);
            } catch (e) {
                log.error && log.error('schedule diff:', e.message);
            }
        }
        const r = await sendPush({ group, date: today, hash, text: change.text, changes: change.days });
        log.log && log.log(`FCM: schedule_update group=${group} hash=${hash.slice(0, 12)} sent=${r && r.sent} failed=${r && r.failed}`);
        return { pushed: true, hash: hash.slice(0, 12), text: change.text, sent: r && r.sent, failed: r && r.failed };
    }

    return { check };
}

module.exports = { effectiveDays, effectiveHash, createMysqlPushStateRepo, createMemoryPushStateRepo, createSchedulePushService };
