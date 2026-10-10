/**
 * Хелперы для GET /api/minute.
 *
 * Раньше фильтр был `DATE(CONVERT_TZ(timestamp, ...)) BETWEEN ...` — функция над колонкой
 * не даёт MySQL использовать индекс (device_id, timestamp) по диапазону, поэтому каждый запрос
 * читал ВСЮ историю устройства (даже за пустой день — ~0.5–0.8 с). Здесь границы суток по Киеву
 * переводятся в UTC заранее, и запрос становится `timestamp >= ? AND timestamp < ?`.
 */
'use strict';

const KYIV_TZ = 'Europe/Kiev';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Поля, которые можно запросить через ?fields=a,b,c (minute всегда включён). */
const MINUTE_FIELDS = new Set([
    'minute', 'date', 'time', 'timestamp', 'device_id', 'device_name', 'is_online',
    'availability_percent', 'avg_power_w', 'total_consumption_kwh', 'voltage_v',
    'ecoflow_charge_percent', 'temperature_c', 'humidity_percent',
]);

const offsetFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: KYIV_TZ,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** Смещение Киева относительно UTC (мс) в момент utcMs. */
function kyivOffsetMs(utcMs) {
    const p = {};
    for (const part of offsetFormatter.formatToParts(new Date(utcMs))) p[part.type] = part.value;
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return asUtc - Math.floor(utcMs / 1000) * 1000;
}

function isValidDate(s) {
    if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** UTC-момент (мс) начала суток YYYY-MM-DD по Киеву (с учётом перехода на летнее время). */
function kyivDayStartUtcMs(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const wall = Date.UTC(y, m - 1, d);
    let utc = wall - kyivOffsetMs(wall);
    utc = wall - kyivOffsetMs(utc);
    return utc;
}

function addDays(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD HH:MM:SS' в UTC — формат для сравнения с DATETIME-колонкой (хранится в UTC). */
function toSqlUtc(ms) {
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Диапазон [fromUtc, toUtc) для суток startDate..endDate включительно по Киеву.
 * Возвращает строки для SQL.
 */
function kyivDateRangeUtc(startDate, endDate) {
    return {
        fromUtc: toSqlUtc(kyivDayStartUtcMs(startDate)),
        toUtc: toSqlUtc(kyivDayStartUtcMs(addDays(endDate, 1))),
    };
}

/** ?fields=avg_power_w,is_online → ['minute','avg_power_w','is_online'] или null (все поля). */
function parseFields(raw) {
    if (raw == null || raw === '') return null;
    const list = String(raw).split(',').map((s) => s.trim()).filter((s) => MINUTE_FIELDS.has(s));
    if (list.length === 0) return null;
    if (!list.includes('minute')) list.unshift('minute');
    return [...new Set(list)];
}

function projectRows(rows, fields) {
    if (!fields) return rows;
    return rows.map((row) => {
        const out = {};
        for (const f of fields) out[f] = row[f];
        return out;
    });
}

module.exports = {
    MINUTE_FIELDS,
    isValidDate,
    kyivDayStartUtcMs,
    kyivDateRangeUtc,
    toSqlUtc,
    addDays,
    parseFields,
    projectRows,
};
