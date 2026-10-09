/**
 * История графиков отключений (YASNO + зеркало ДТЭК outage-data-ua).
 *
 * - parseYasno / parseDtek — приводят ответы источников к единому виду:
 *     { date: 'YYYY-MM-DD', group: '49.1', source: 'yasno'|'dtek', status, slots: [{start,end,type:'off'|'maybe'}], sourceUpdatedAt }
 *   start/end — минуты от начала суток по Киеву (0..1440), соседние интервалы одного типа склеены.
 * - createScheduleService({ repo, fetchImpl, now, ... }) — опрос источников не чаще раза в N минут,
 *   запись только изменившихся графиков (дедупликация по хэшу содержимого), выдача для GET /api/schedules.
 *
 * Хранилище (repo) — см. scheduleRepo.js (MySQL) и test/memoryRepo.js (для тестов).
 */
const crypto = require('crypto');

const KYIV_TZ = 'Europe/Kiev';
const YASNO_URL = process.env.YASNO_URL ||
    'https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages';
const DTEK_URL = process.env.DTEK_MIRROR_URL ||
    'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/kyiv.json';
const DEFAULT_INTERVAL_MIN = parseInt(process.env.SCHEDULE_REFRESH_MINUTES || '15', 10);

/* ---------------- время ---------------- */
function kyivParts(date) {
    const f = new Intl.DateTimeFormat('en-CA', {
        timeZone: KYIV_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    const p = {};
    f.formatToParts(date).forEach((x) => { p[x.type] = x.value; });
    return { key: `${p.year}-${p.month}-${p.day}`, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
function kyivDateKey(date) { return kyivParts(date).key; }
/** «09.10.2026 01:35» (время Киева) → Date (UTC) */
function kyivLocalToDate(str) {
    const m = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2})/.exec(String(str || '').trim());
    if (!m) return null;
    const guess = Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]);
    // смещение Киева в этот момент (+2/+3)
    const p = kyivParts(new Date(guess));
    const asUtc = Date.UTC(+p.key.slice(0, 4), +p.key.slice(5, 7) - 1, +p.key.slice(8, 10), p.h, p.mi);
    return new Date(guess - (asUtc - guess));
}
function addDays(key, n) {
    const d = new Date(`${key}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}
function isDateKey(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

/* ---------------- нормализация ---------------- */
function normalizeSlots(slots) {
    const list = (slots || [])
        .filter((s) => s && (s.type === 'off' || s.type === 'maybe') && s.end > s.start)
        .map((s) => ({ start: Math.max(0, Math.round(s.start)), end: Math.min(1440, Math.round(s.end)), type: s.type }))
        .sort((a, b) => a.start - b.start);
    const out = [];
    list.forEach((s) => {
        const last = out[out.length - 1];
        if (last && last.type === s.type && last.end >= s.start) last.end = Math.max(last.end, s.end);
        else out.push({ ...s });
    });
    return out;
}
function contentHash(status, slots) {
    return crypto.createHash('sha1').update(JSON.stringify({ status: status || null, slots })).digest('hex');
}
function minutesOf(slots, type) { return slots.filter((s) => s.type === type).reduce((a, s) => a + s.end - s.start, 0); }
function groupWanted(group, groups) {
    if (!groups || groups === '*' || (Array.isArray(groups) && groups.includes('*'))) return true;
    return (Array.isArray(groups) ? groups : String(groups).split(',')).map((g) => g.trim()).includes(group);
}

/* ---------------- YASNO ---------------- */
const YASNO_TYPE = (t) => (/Definite/i.test(t) ? 'off' : /Possible|Probable/i.test(t) ? 'maybe' : null);
function parseYasno(json, groups = '*') {
    const out = [];
    if (!json || typeof json !== 'object') return out;
    Object.keys(json).forEach((group) => {
        if (!/^\d+(\.\d+)?$/.test(group) || !groupWanted(group, groups)) return;
        const g = json[group];
        ['today', 'tomorrow'].forEach((k) => {
            const d = g && g[k];
            if (!d || !d.date) return;
            const date = String(d.date).slice(0, 10);   // "2026-10-09T00:00:00+03:00" — уже по Киеву
            if (!isDateKey(date)) return;
            const slots = normalizeSlots((d.slots || []).map((s) => ({ start: s.start, end: s.end, type: YASNO_TYPE(String(s.type || '')) })));
            out.push({ date, group, source: 'yasno', status: d.status || null, slots,
                sourceUpdatedAt: g.updatedOn ? new Date(g.updatedOn) : null });
        });
    });
    return out;
}

/* ---------------- ДТЭК (зеркало outage-data-ua) ---------------- */
// значение часа → [первая половина, вторая половина]
const DTEK_MAP = {
    yes: [null, null], no: ['off', 'off'], first: ['off', null], second: [null, 'off'],
    maybe: ['maybe', 'maybe'], mfirst: ['maybe', null], msecond: [null, 'maybe'],
};
function parseDtek(json, groups = '*', opts = {}) {
    const out = [];
    const fact = json && json.fact;
    if (!fact || !fact.data) return out;
    const updated = kyivLocalToDate(fact.update) || (json.lastUpdated ? new Date(json.lastUpdated) : null);
    Object.keys(fact.data).forEach((ts) => {
        const date = kyivDateKey(new Date((+ts + 12 * 3600) * 1000));   // ts — полночь по Киеву; +12ч — защита от DST
        if (opts.onlyDate && date !== opts.onlyDate) return;
        const day = fact.data[ts] || {};
        Object.keys(day).forEach((gkey) => {
            const m = /^GPV(\d+(?:\.\d+)?)$/.exec(gkey);
            if (!m || !groupWanted(m[1], groups)) return;
            const hours = day[gkey] || {};
            const raw = [];
            for (let h = 1; h <= 24; h++) {
                const v = DTEK_MAP[String(hours[String(h)])];
                if (!v) continue;
                if (v[0]) raw.push({ start: (h - 1) * 60, end: (h - 1) * 60 + 30, type: v[0] });
                if (v[1]) raw.push({ start: (h - 1) * 60 + 30, end: h * 60, type: v[1] });
            }
            out.push({ date, group: m[1], source: 'dtek', status: 'ScheduleApplies', slots: normalizeSlots(raw), sourceUpdatedAt: updated });
        });
    });
    // fact.today есть, а данных на этот день нет — ДТЭК график не публиковал (отключения не планировались).
    // Сохраняем это явно (status NoSchedule, пустые слоты) для всех очередей из preset.sch_names.
    if (fact.today) {
        const todayKey = kyivDateKey(new Date((+fact.today + 12 * 3600) * 1000));
        const known = (json.preset && json.preset.sch_names) ? Object.keys(json.preset.sch_names) : [];
        if ((!opts.onlyDate || opts.onlyDate === todayKey) && !out.some((x) => x.date === todayKey)) {
            known.forEach((gkey) => {
                const m = /^GPV(\d+(?:\.\d+)?)$/.exec(gkey);
                if (m && groupWanted(m[1], groups)) out.push({ date: todayKey, group: m[1], source: 'dtek', status: 'NoSchedule', slots: [], sourceUpdatedAt: updated });
            });
        }
    }
    return out;
}

/* ---------------- сервис ---------------- */
function createScheduleService({
    repo,
    fetchImpl = (typeof fetch === 'function' ? fetch : null),
    now = () => new Date(),
    groups = process.env.SCHEDULE_GROUPS || '*',
    intervalMinutes = DEFAULT_INTERVAL_MIN,
    timeoutMs = 8000,
    sources = { yasno: YASNO_URL, dtek: DTEK_URL },
    log = console,
} = {}) {
    if (!repo) throw new Error('schedules: repo is required');
    let lastLocalAttempt = 0;

    async function getJson(url) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const r = await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': 'roz-power-monitor' } });
            if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
            return await r.json();
        } finally { clearTimeout(t); }
    }

    /** Сохраняет снимки; пишет только изменившиеся (по хэшу). Возвращает число новых версий. */
    async function store(items, { origin = 'live', seenAt = now() } = {}) {
        if (!items.length) return { inserted: 0, unchanged: 0 };
        const rows = items.map((it) => ({
            ...it,
            hash: contentHash(it.status, it.slots),
            offMinutes: minutesOf(it.slots, 'off'),
            maybeMinutes: minutesOf(it.slots, 'maybe'),
            origin,
            seenAt,
        }));
        const dates = [...new Set(rows.map((r) => r.date))];
        const latest = await repo.getLatestHashes(dates);   // Map 'date|group|source' → hash текущей версии
        const changed = rows.filter((r) => latest.get(`${r.date}|${r.group}|${r.source}`) !== r.hash);
        await repo.upsertVersions(rows);                     // новые — INSERT, прежние — обновить last_seen_at
        return { inserted: changed.length, unchanged: rows.length - changed.length, changed: changed.map((r) => `${r.date} ${r.group} ${r.source}`) };
    }

    async function refreshSource(name) {
        const json = await getJson(sources[name]);
        const items = name === 'yasno' ? parseYasno(json, groups) : parseDtek(json, groups);
        if (!items.length) throw new Error(`${name}: пустой или неизвестный формат`);
        return store(items);
    }

    /**
     * Вызывается из POST /monitor каждую минуту; реально опрашивает источники не чаще раза в intervalMinutes
     * (защита и в памяти инстанса, и в БД — на случай нескольких инстансов Cloud Run).
     */
    async function maybeRefresh({ force = false } = {}) {
        const t = now().getTime();
        if (!force && t - lastLocalAttempt < intervalMinutes * 60000) return { skipped: 'local-interval' };
        lastLocalAttempt = t;
        const claimed = force ? true : await repo.claimFetchSlot('schedules', intervalMinutes);
        if (!claimed) return { skipped: 'db-interval' };
        const result = {};
        for (const name of Object.keys(sources)) {
            try {
                result[name] = await refreshSource(name);
                await repo.setFetchState(name, { ok: true, changes: result[name].inserted });
            } catch (e) {
                result[name] = { error: e.message };
                log.error && log.error(`Графики ${name}: ${e.message}`);
                try { await repo.setFetchState(name, { ok: false, error: e.message }); } catch (_) { /* noop */ }
            }
        }
        return result;
    }

    /** Данные для GET /api/schedules */
    async function query({ group, startDate, endDate, source = null, versions = false }) {
        if (!group || !/^\d+(\.\d+)?$/.test(group)) throw Object.assign(new Error('Параметр group обязателен, напр. 49.1'), { status: 400 });
        const today = kyivDateKey(now());
        startDate = startDate || addDays(today, -6);
        endDate = endDate || addDays(today, 1);
        if (!isDateKey(startDate) || !isDateKey(endDate) || startDate > endDate) {
            throw Object.assign(new Error('startDate/endDate в формате YYYY-MM-DD, startDate <= endDate'), { status: 400 });
        }
        if ((Date.parse(endDate) - Date.parse(startDate)) / 86400000 > 400) throw Object.assign(new Error('Период не больше 400 дней'), { status: 400 });
        const rows = await repo.getRange(group, startDate, endDate, source);
        const days = {};
        rows.forEach((r) => {
            const d = (days[r.date] = days[r.date] || {});
            const v = { status: r.status, slots: r.slots, offMinutes: r.offMinutes, maybeMinutes: r.maybeMinutes,
                sourceUpdatedAt: r.sourceUpdatedAt, firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt, origin: r.origin };
            const cur = d[r.source];
            // актуальная версия — та, что видели последней
            if (!cur || new Date(r.lastSeenAt) > new Date(cur.lastSeenAt)) d[r.source] = { ...v, versions: cur ? cur.versions : [] };
            if (versions) {
                d[r.source].versions = (d[r.source].versions || []).concat([v]).sort((a, b) => new Date(a.firstSeenAt) - new Date(b.firstSeenAt));
            }
        });
        if (!versions) Object.values(days).forEach((d) => Object.values(d).forEach((v) => { delete v.versions; }));
        const fetchState = repo.getFetchStates ? await repo.getFetchStates() : null;
        return { success: true, group, startDate, endDate, timezone: KYIV_TZ, days, fetchState };
    }

    return { maybeRefresh, refreshSource, store, query };
}

/** Регистрирует GET /api/schedules и GET /api/schedules/refresh-status */
function registerScheduleRoutes(app, service) {
    app.get('/api/schedules', async (req, res) => {
        try {
            const data = await service.query({
                group: String(req.query.group || process.env.SCHEDULE_DEFAULT_GROUP || '49.1'),
                startDate: req.query.startDate,
                endDate: req.query.endDate,
                source: req.query.source === 'yasno' || req.query.source === 'dtek' ? req.query.source : null,
                versions: req.query.versions === '1' || req.query.versions === 'true',
            });
            res.json(data);
        } catch (e) {
            res.status(e.status || 500).json({ success: false, error: e.message });
        }
    });
}

module.exports = {
    parseYasno, parseDtek, normalizeSlots, contentHash, kyivDateKey, kyivLocalToDate, addDays,
    createScheduleService, registerScheduleRoutes, YASNO_URL, DTEK_URL,
};
