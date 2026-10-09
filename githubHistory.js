/**
 * Восстановление прошлых графиков ДТЭК из git-истории зеркала Baskerville42/outage-data-ua (data/kyiv.json).
 * На каждый день — 1 запрос к GitHub API (последний коммит файла до конца дня по Киеву)
 * + 1 загрузка raw-файла этого коммита (raw.githubusercontent.com не расходует лимит API).
 * Без токена лимит API — 60 запросов/час с IP, с GITHUB_TOKEN — 5000/час.
 * История файла начинается 06.11.2025; очереди вида 49.1 (60 подгрупп) — с 28.01.2026,
 * до этого ДТЭК использовал 12 очередей 1.1–6.2.
 */
const { parseDtek, kyivLocalToDate, addDays } = require('./schedules');

const REPO = process.env.DTEK_HISTORY_REPO || 'Baskerville42/outage-data-ua';
const FILE = process.env.DTEK_HISTORY_PATH || 'data/kyiv.json';
const HISTORY_START = '2025-11-06';

class RateLimitError extends Error {
    constructor(resetAt) { super(`GitHub API: лимит исчерпан до ${resetAt.toISOString()}`); this.resetAt = resetAt; }
}

/** Полночь по Киеву (UTC Date) для YYYY-MM-DD */
function kyivMidnight(date) {
    const [y, m, d] = date.split('-');
    return kyivLocalToDate(`${d}.${m}.${y} 00:00`);
}

function createGithubHistory({ fetchImpl = fetch, token = process.env.GITHUB_TOKEN || null, log = console } = {}) {
    const rate = { remaining: null, resetAt: null };

    async function api(url) {
        const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'roz-schedule-backfill' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const r = await fetchImpl(url, { headers });
        const rem = r.headers.get('x-ratelimit-remaining'), reset = r.headers.get('x-ratelimit-reset');
        if (rem != null) rate.remaining = +rem;
        if (reset != null) rate.resetAt = new Date(+reset * 1000);
        if ((r.status === 403 || r.status === 429) && rate.remaining === 0) throw new RateLimitError(rate.resetAt || new Date(Date.now() + 3600e3));
        if (!r.ok) throw new Error(`GitHub API HTTP ${r.status}`);
        return r.json();
    }

    /** Последний коммит файла не позже конца дня date (Киев) */
    async function lastCommitOfDay(date) {
        const until = new Date(kyivMidnight(addDays(date, 1)).getTime() - 1000).toISOString().replace('.000Z', 'Z');
        const url = `https://api.github.com/repos/${REPO}/commits?path=${encodeURIComponent(FILE)}&until=${until}&per_page=1`;
        const list = await api(url);
        if (!Array.isArray(list) || !list.length) return null;
        return { sha: list[0].sha, date: new Date(list[0].commit.committer.date) };
    }

    async function rawAt(sha) {
        const r = await fetchImpl(`https://raw.githubusercontent.com/${REPO}/${sha}/${FILE}`, { headers: { 'User-Agent': 'roz-schedule-backfill' } });
        if (!r.ok) throw new Error(`raw HTTP ${r.status} @${sha.slice(0, 7)}`);
        return r.json();
    }

    /** Итоговый (последний за день) график ДТЭК на дату для выбранных очередей */
    async function fetchDay(date, groups = '*') {
        if (date < HISTORY_START) return { date, items: [], note: 'до начала истории' };
        const c = await lastCommitOfDay(date);
        if (!c) return { date, items: [], note: 'нет коммитов' };
        const json = await rawAt(c.sha);
        const items = parseDtek(json, groups, { onlyDate: date });
        return { date, sha: c.sha, commitDate: c.date, items, note: items.length ? null : 'в снимке нет этой даты/очереди' };
    }

    return { fetchDay, lastCommitOfDay, rawAt, rate };
}

module.exports = { createGithubHistory, RateLimitError, kyivMidnight, HISTORY_START };
