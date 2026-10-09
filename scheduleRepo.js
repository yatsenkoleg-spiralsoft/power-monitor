/**
 * MySQL-хранилище истории графиков (таблицы из migrations/004_outage_schedules.sql).
 * Все даты-время пишутся в UTC (DATETIME), дата графика — DATE по Киеву.
 */
function toSqlDateTime(d) {
    if (!d) return null;
    const x = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(x.getTime())) return null;
    return x.toISOString().slice(0, 19).replace('T', ' ');
}
function fromSqlDateTime(v) {
    if (!v) return null;
    if (v instanceof Date) return v.toISOString();          // mysql2 отдаёт Date (в TZ процесса; на Cloud Run — UTC)
    return new Date(String(v).replace(' ', 'T') + 'Z').toISOString();
}
function fromSqlDate(v) {
    if (v instanceof Date) {   // mysql2 превращает DATE в локальную полночь
        const p = (n) => String(n).padStart(2, '0');
        return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
    }
    return String(v).slice(0, 10);
}

function createMysqlScheduleRepo(getPool) {
    const pool = () => getPool();

    async function getLatestHashes(dates) {
        const map = new Map();
        if (!dates.length) return map;
        const [rows] = await pool().query(
            `SELECT s.schedule_date, s.group_code, s.source, s.content_hash
               FROM outage_schedules s
               JOIN (SELECT schedule_date, group_code, source, MAX(last_seen_at) AS mx
                       FROM outage_schedules WHERE schedule_date IN (?)
                      GROUP BY schedule_date, group_code, source) t
                 ON t.schedule_date = s.schedule_date AND t.group_code = s.group_code
                AND t.source = s.source AND t.mx = s.last_seen_at`,
            [dates]
        );
        rows.forEach((r) => map.set(`${fromSqlDate(r.schedule_date)}|${r.group_code}|${r.source}`, r.content_hash));
        return map;
    }

    async function upsertVersions(rows) {
        if (!rows.length) return;
        const values = rows.map((r) => [
            r.date, r.group, r.source, r.status, JSON.stringify(r.slots), r.offMinutes, r.maybeMinutes, r.hash,
            toSqlDateTime(r.sourceUpdatedAt), toSqlDateTime(r.seenAt), toSqlDateTime(r.seenAt), r.origin,
        ]);
        // пачками, чтобы не упереться в max_allowed_packet
        for (let i = 0; i < values.length; i += 200) {
            await pool().query(
                `INSERT INTO outage_schedules
                    (schedule_date, group_code, source, status, slots, off_minutes, maybe_minutes, content_hash,
                     source_updated_at, first_seen_at, last_seen_at, origin)
                 VALUES ?
                 ON DUPLICATE KEY UPDATE
                    last_seen_at = GREATEST(last_seen_at, VALUES(last_seen_at)),
                    first_seen_at = LEAST(first_seen_at, VALUES(first_seen_at)),
                    source_updated_at = COALESCE(VALUES(source_updated_at), source_updated_at)`,
                [values.slice(i, i + 200)]
            );
        }
    }

    async function getRange(group, startDate, endDate, source) {
        const [rows] = await pool().query(
            `SELECT schedule_date, group_code, source, status, slots, off_minutes, maybe_minutes,
                    source_updated_at, first_seen_at, last_seen_at, origin
               FROM outage_schedules
              WHERE group_code = ? AND schedule_date BETWEEN ? AND ? ${source ? 'AND source = ?' : ''}
              ORDER BY schedule_date, source, first_seen_at`,
            source ? [group, startDate, endDate, source] : [group, startDate, endDate]
        );
        return rows.map((r) => ({
            date: fromSqlDate(r.schedule_date), group: r.group_code, source: r.source, status: r.status,
            slots: typeof r.slots === 'string' ? JSON.parse(r.slots) : r.slots,
            offMinutes: r.off_minutes, maybeMinutes: r.maybe_minutes,
            sourceUpdatedAt: fromSqlDateTime(r.source_updated_at),
            firstSeenAt: fromSqlDateTime(r.first_seen_at), lastSeenAt: fromSqlDateTime(r.last_seen_at), origin: r.origin,
        }));
    }

    /** Атомарно «занимает» слот опроса: true, если прошло >= minutes с прошлой попытки (любого инстанса). */
    async function claimFetchSlot(name, minutes) {
        const [res] = await pool().query(
            `UPDATE schedule_fetch_state SET last_attempt_at = UTC_TIMESTAMP()
              WHERE source = ? AND (last_attempt_at IS NULL OR last_attempt_at < UTC_TIMESTAMP() - INTERVAL ? MINUTE)`,
            [name, Math.max(1, Math.round(minutes))]
        );
        if (res.affectedRows > 0) return true;
        // строки ещё нет (миграция без INSERT) — создаём и разрешаем
        const [ins] = await pool().query(
            `INSERT IGNORE INTO schedule_fetch_state (source, last_attempt_at) VALUES (?, UTC_TIMESTAMP())`, [name]
        );
        return ins.affectedRows > 0;
    }

    async function setFetchState(name, { ok, error = null, changes = 0 }) {
        await pool().query(
            `INSERT INTO schedule_fetch_state (source, last_attempt_at, last_ok_at, last_error, last_changes)
             VALUES (?, UTC_TIMESTAMP(), ${ok ? 'UTC_TIMESTAMP()' : 'NULL'}, ?, ?)
             ON DUPLICATE KEY UPDATE last_attempt_at = VALUES(last_attempt_at),
                last_ok_at = ${ok ? 'VALUES(last_ok_at)' : 'last_ok_at'},
                last_error = VALUES(last_error), last_changes = VALUES(last_changes)`,
            [name, ok ? null : String(error || '').slice(0, 255), changes || 0]
        );
    }

    async function getFetchStates() {
        const [rows] = await pool().query(`SELECT source, last_attempt_at, last_ok_at, last_error, last_changes FROM schedule_fetch_state`);
        const out = {};
        rows.forEach((r) => {
            out[r.source] = { lastAttemptAt: fromSqlDateTime(r.last_attempt_at), lastOkAt: fromSqlDateTime(r.last_ok_at),
                lastError: r.last_error, lastChanges: r.last_changes };
        });
        return out;
    }

    return { getLatestHashes, upsertVersions, getRange, claimFetchSlot, setFetchState, getFetchStates };
}

module.exports = { createMysqlScheduleRepo, toSqlDateTime, fromSqlDateTime, fromSqlDate };
