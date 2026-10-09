/* Запуск: node --test test/   (Node 18+). Без сети и без MySQL: fetch и БД подменены. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const S = require('../schedules');
const { createMemoryRepo } = require('./memoryRepo');
const { createMysqlScheduleRepo } = require('../scheduleRepo');
const { createGithubHistory, RateLimitError, kyivMidnight } = require('../githubHistory');

const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));
const res = (body, { status = 200, headers = {} } = {}) => ({
    ok: status >= 200 && status < 300, status, json: async () => body,
    headers: { get: (k) => (headers[k.toLowerCase()] ?? null) },
});
const quiet = { error() {}, log() {} };

test('kyivLocalToDate учитывает летнее/зимнее время', () => {
    assert.equal(S.kyivLocalToDate('09.10.2026 01:35').toISOString(), '2026-10-08T22:35:00.000Z');   // UTC+3
    assert.equal(S.kyivLocalToDate('15.12.2025 10:00').toISOString(), '2025-12-15T08:00:00.000Z');   // UTC+2
    assert.equal(kyivMidnight('2026-03-29').toISOString(), '2026-03-28T22:00:00.000Z');              // день перехода на летнее
    assert.equal(S.kyivLocalToDate('мусор'), null);
});

test('normalizeSlots склеивает соседние интервалы и отбрасывает лишнее', () => {
    assert.deepEqual(S.normalizeSlots([
        { start: 60, end: 90, type: 'off' }, { start: 0, end: 30, type: 'off' }, { start: 30, end: 60, type: 'off' },
        { start: 90, end: 120, type: 'maybe' }, { start: 200, end: 100, type: 'off' }, { start: 300, end: 330, type: null },
    ]), [{ start: 0, end: 90, type: 'off' }, { start: 90, end: 120, type: 'maybe' }]);
});

test('parseYasno: сегодня/завтра, Definite → off, статус и updatedOn', () => {
    const items = S.parseYasno(fx('yasno.json'), '49.1');
    assert.equal(items.length, 2);
    const today = items.find((i) => i.date === '2026-10-09');
    assert.deepEqual(today.slots, [{ start: 0, end: 90, type: 'off' }, { start: 1080, end: 1290, type: 'off' }]);
    assert.equal(today.status, 'ScheduleApplies');
    assert.equal(today.source, 'yasno');
    assert.ok(today.sourceUpdatedAt instanceof Date);
    const tomorrow = items.find((i) => i.date === '2026-10-10');
    assert.equal(tomorrow.status, 'WaitingForSchedule');
    assert.deepEqual(tomorrow.slots, []);
    assert.equal(S.parseYasno(fx('yasno.json'), '*').length, 4);
    assert.deepEqual(S.parseYasno(null), []);
});

test('parseDtek: часы/половинки → минуты, дата по Киеву, совпадает с YASNO', () => {
    const items = S.parseDtek(fx('dtek.json'), '49.1');
    assert.equal(items.length, 1);
    assert.equal(items[0].date, '2026-10-09');
    assert.equal(items[0].source, 'dtek');
    assert.deepEqual(items[0].slots, [{ start: 0, end: 90, type: 'off' }, { start: 1080, end: 1290, type: 'off' }]);
    assert.equal(items[0].sourceUpdatedAt.toISOString(), '2026-10-08T22:35:00.000Z');
    const y = S.parseYasno(fx('yasno.json'), '49.1').find((i) => i.date === '2026-10-09');
    assert.equal(S.contentHash(null, items[0].slots), S.contentHash(null, y.slots));
});

test('parseDtek: пустой fact.data → NoSchedule для всех очередей на fact.today', () => {
    const items = S.parseDtek(fx('dtek-empty.json'), '*');
    assert.deepEqual(items.map((i) => [i.date, i.group, i.status, i.slots.length]).sort(),
        [['2026-10-05', '45.1', 'NoSchedule', 0], ['2026-10-05', '49.1', 'NoSchedule', 0]]);
    assert.deepEqual(S.parseDtek(fx('dtek-empty.json'), '*', { onlyDate: '2026-10-04' }), []);
});

test('store: запись только при изменении, история версий, A→B→A', async () => {
    const repo = createMemoryRepo();
    let t = new Date('2026-10-09T03:00:00Z');
    const svc = S.createScheduleService({ repo, now: () => t, log: quiet });
    const base = S.parseYasno(fx('yasno.json'), '49.1');
    assert.equal((await svc.store(base)).inserted, 2);
    t = new Date('2026-10-09T03:15:00Z');
    let r = await svc.store(base);
    assert.equal(r.inserted, 0); assert.equal(r.unchanged, 2);
    assert.equal(repo.rows.length, 2);
    assert.equal(repo.rows[0].lastSeenAt, '2026-10-09T03:15:00.000Z');   // «видели снова»
    assert.equal(repo.rows[0].firstSeenAt, '2026-10-09T03:00:00.000Z');
    // B: график на завтра опубликовали
    const B = JSON.parse(JSON.stringify(base)); B[1].status = 'ScheduleApplies'; B[1].slots = [{ start: 600, end: 840, type: 'off' }];
    t = new Date('2026-10-09T03:30:00Z');
    r = await svc.store(B); assert.equal(r.inserted, 1); assert.deepEqual(r.changed, ['2026-10-10 49.1 yasno']);
    assert.equal(repo.rows.length, 3);
    // A снова (откатили) → новая строка не нужна, но актуальной становится A
    t = new Date('2026-10-09T03:45:00Z');
    r = await svc.store(base); assert.equal(r.inserted, 1);
    assert.equal(repo.rows.length, 3);
    const q = await svc.query({ group: '49.1', startDate: '2026-10-09', endDate: '2026-10-10', versions: true });
    assert.equal(q.days['2026-10-10'].yasno.status, 'WaitingForSchedule');
    assert.equal(q.days['2026-10-10'].yasno.versions.length, 2);
    assert.equal(q.days['2026-10-09'].yasno.offMinutes, 300);
});

test('maybeRefresh: не чаще раза в 15 минут (память + БД), оба источника, ошибки не роняют', async () => {
    const repo = createMemoryRepo();
    let t = new Date('2026-10-09T03:00:00Z');
    repo.setClock(() => t);
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(url);
        if (url.includes('yasno')) return res(fx('yasno.json'));
        if (url.includes('fail')) return res({}, { status: 503 });
        return res(fx('dtek.json'));
    };
    const svc = S.createScheduleService({ repo, fetchImpl, now: () => t, groups: '49.1', log: quiet,
        sources: { yasno: 'https://yasno.test/x', dtek: 'https://raw.test/kyiv.json' } });
    const r1 = await svc.maybeRefresh();
    assert.equal(r1.yasno.inserted, 2); assert.equal(r1.dtek.inserted, 1);
    assert.equal(calls.length, 2);
    t = new Date('2026-10-09T03:01:00Z');
    assert.deepEqual(await svc.maybeRefresh(), { skipped: 'local-interval' });
    // другой инстанс (своя память), но тот же «БД»-слот
    const svc2 = S.createScheduleService({ repo, fetchImpl, now: () => t, groups: '49.1', log: quiet,
        sources: { yasno: 'https://yasno.test/x', dtek: 'https://raw.test/kyiv.json' } });
    assert.deepEqual(await svc2.maybeRefresh(), { skipped: 'db-interval' });
    assert.equal(calls.length, 2);
    t = new Date('2026-10-09T03:16:00Z');
    const r3 = await svc.maybeRefresh();
    assert.equal(r3.yasno.inserted, 0); assert.equal(calls.length, 4);
    // источник упал — второй всё равно обработан, ошибка в fetch_state
    const svc3 = S.createScheduleService({ repo, fetchImpl, now: () => t, groups: '49.1', log: quiet,
        sources: { yasno: 'https://yasno.test/x', dtek: 'https://fail.test/' } });
    const r4 = await svc3.maybeRefresh({ force: true });
    assert.match(r4.dtek.error, /503/); assert.equal(r4.yasno.inserted, 0);
    assert.equal(repo.fetchState.dtek.ok, false);
});

test('GET /api/schedules через express: формат, валидация', async (t) => {
    let express;
    try { express = require('express'); } catch (_) { t.skip('express не установлен (npm install)'); return; }
    const repo = createMemoryRepo();
    const svc = S.createScheduleService({ repo, now: () => new Date('2026-10-09T03:00:00Z'), log: quiet });
    await svc.store(S.parseYasno(fx('yasno.json'), '*'));
    await svc.store(S.parseDtek(fx('dtek.json'), '*'));
    const app = express(); S.registerScheduleRoutes(app, svc);
    const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
        const j = await (await fetch(`${base}/api/schedules?group=49.1&startDate=2026-10-08&endDate=2026-10-10`)).json();
        assert.equal(j.success, true);
        assert.deepEqual(Object.keys(j.days).sort(), ['2026-10-09', '2026-10-10']);
        assert.deepEqual(Object.keys(j.days['2026-10-09']).sort(), ['dtek', 'yasno']);
        assert.equal(j.days['2026-10-09'].dtek.offMinutes, 300);
        assert.equal(j.days['2026-10-09'].yasno.versions, undefined);
        const only = await (await fetch(`${base}/api/schedules?group=49.1&startDate=2026-10-09&endDate=2026-10-09&source=dtek`)).json();
        assert.deepEqual(Object.keys(only.days['2026-10-09']), ['dtek']);
        const def = await (await fetch(`${base}/api/schedules`)).json();          // group по умолчанию 49.1, последние 7 дней + завтра
        assert.equal(def.group, '49.1'); assert.equal(def.startDate, '2026-10-03'); assert.equal(def.endDate, '2026-10-10');
        const bad = await fetch(`${base}/api/schedules?group=abc`);
        assert.equal(bad.status, 400);
        const bad2 = await fetch(`${base}/api/schedules?group=49.1&startDate=2026-10-10&endDate=2026-10-01`);
        assert.equal(bad2.status, 400);
    } finally { srv.close(); }
});

test('MySQL-репозиторий: SQL и параметры (подменённый pool)', async () => {
    const q = [];
    const pool = { query: async (sql, params) => {
        q.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        if (/^SELECT s.schedule_date/.test(q[q.length - 1].sql)) return [[{ schedule_date: new Date(2026, 9, 9), group_code: '49.1', source: 'yasno', content_hash: 'h1' }]];
        if (/^UPDATE schedule_fetch_state/.test(q[q.length - 1].sql)) return [{ affectedRows: 0 }];
        if (/^INSERT IGNORE/.test(q[q.length - 1].sql)) return [{ affectedRows: 0 }];
        if (/^SELECT schedule_date/.test(q[q.length - 1].sql)) return [[{ schedule_date: new Date(2026, 9, 9), group_code: '49.1', source: 'dtek', status: 'ScheduleApplies',
            slots: '[{"start":0,"end":90,"type":"off"}]', off_minutes: 90, maybe_minutes: 0, source_updated_at: null,
            first_seen_at: new Date('2026-10-09T03:00:00Z'), last_seen_at: new Date('2026-10-09T03:15:00Z'), origin: 'live' }]];
        return [{ affectedRows: 1 }];
    } };
    const repo = createMysqlScheduleRepo(() => pool);
    const m = await repo.getLatestHashes(['2026-10-09']);
    assert.equal(m.get('2026-10-09|49.1|yasno'), 'h1');
    assert.deepEqual(q[0].params, [['2026-10-09']]);
    await repo.upsertVersions([{ date: '2026-10-09', group: '49.1', source: 'yasno', status: 'S', slots: [{ start: 0, end: 90, type: 'off' }],
        offMinutes: 90, maybeMinutes: 0, hash: 'abc', sourceUpdatedAt: new Date('2026-10-09T00:43:15Z'), seenAt: new Date('2026-10-09T03:00:00Z'), origin: 'live' }]);
    const ins = q[1];
    assert.match(ins.sql, /^INSERT INTO outage_schedules .* VALUES \? ON DUPLICATE KEY UPDATE last_seen_at = GREATEST/);
    assert.deepEqual(ins.params[0][0], ['2026-10-09', '49.1', 'yasno', 'S', '[{"start":0,"end":90,"type":"off"}]', 90, 0, 'abc',
        '2026-10-09 00:43:15', '2026-10-09 03:00:00', '2026-10-09 03:00:00', 'live']);
    assert.equal(await repo.claimFetchSlot('schedules', 15), false);
    assert.deepEqual(q[2].params, ['schedules', 15]);
    const rows = await repo.getRange('49.1', '2026-10-09', '2026-10-09', 'dtek');
    assert.equal(rows[0].date, '2026-10-09'); assert.deepEqual(rows[0].slots, [{ start: 0, end: 90, type: 'off' }]);
    assert.match(q[4].sql, /AND source = \?/);
});

test('GitHub-история: until = конец дня по Киеву, raw по sha, лимит', async () => {
    const urls = [];
    const fetchImpl = async (url) => {
        urls.push(url);
        if (url.startsWith('https://api.github.com/')) {
            return res([{ sha: 'a'.repeat(40), commit: { committer: { date: '2026-10-08T20:58:38Z' } } }], { headers: { 'x-ratelimit-remaining': '41', 'x-ratelimit-reset': '1791518919' } });
        }
        return res(fx('dtek.json'));
    };
    const gh = createGithubHistory({ fetchImpl, token: null });
    const day = await gh.fetchDay('2026-10-09', '49.1');
    assert.match(urls[0], /until=2026-10-09T20:59:59Z/);
    assert.match(urls[0], /path=data%2Fkyiv\.json/);
    assert.equal(urls[1], `https://raw.githubusercontent.com/Baskerville42/outage-data-ua/${'a'.repeat(40)}/data/kyiv.json`);
    assert.equal(day.items.length, 1); assert.equal(gh.rate.remaining, 41);
    const winter = await createGithubHistory({ fetchImpl }).lastCommitOfDay('2025-12-15');
    assert.ok(winter); assert.match(urls[urls.length - 1], /until=2025-12-15T21:59:59Z/);
    assert.equal((await gh.fetchDay('2025-10-01')).note, 'до начала истории');
    const limited = createGithubHistory({ fetchImpl: async () => res({ message: 'rate limit' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791518919' } }) });
    await assert.rejects(limited.fetchDay('2026-10-01'), RateLimitError);
});
