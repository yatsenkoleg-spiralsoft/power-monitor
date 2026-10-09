/* Интеграционный тест с настоящим MySQL/MariaDB (пропускается, если не задан ROZ_TEST_MYSQL=1).
 *   ROZ_TEST_MYSQL=1 MYSQL_HOST=127.0.0.1 MYSQL_PORT=3307 MYSQL_DATABASE=roztest MYSQL_USER=roz MYSQL_PASSWORD=... node --test test/
 * ВНИМАНИЕ: очищает таблицы outage_schedules / schedule_fetch_state в указанной БД — только для тестовой базы!
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const S = require('../schedules');
const { createMysqlScheduleRepo } = require('../scheduleRepo');

const enabled = process.env.ROZ_TEST_MYSQL === '1';
const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));
const res = (body) => ({ ok: true, status: 200, json: async () => body, headers: { get: () => null } });

test('MySQL: миграция, дедупликация, слот опроса, выборка', { skip: !enabled && 'ROZ_TEST_MYSQL не задан' }, async () => {
    const mysql = require('mysql2/promise');
    const pool = mysql.createPool({ host: process.env.MYSQL_HOST, port: +process.env.MYSQL_PORT || 3306, database: process.env.MYSQL_DATABASE,
        user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, timezone: 'Z' });
    try {
        await pool.query(fs.readFileSync(path.join(__dirname, '..', 'migrations', '004_outage_schedules.sql'), 'utf8').split(';').filter((x) => x.trim()).join(';'), []).catch(() => {});
        await pool.query('DELETE FROM outage_schedules');
        await pool.query('UPDATE schedule_fetch_state SET last_attempt_at = NULL, last_ok_at = NULL, last_error = NULL, last_changes = 0');
        const repo = createMysqlScheduleRepo(() => pool);
        let yasno = fx('yasno.json');
        const fetchImpl = async (url) => res(url.includes('yasno') ? yasno : fx('dtek.json'));
        const mk = () => S.createScheduleService({ repo, fetchImpl, groups: '49.1', log: { error() {} }, sources: { yasno: 'https://yasno.test', dtek: 'https://dtek.test' } });

        const a = mk();
        const r1 = await a.maybeRefresh();
        assert.equal(r1.yasno.inserted, 2); assert.equal(r1.dtek.inserted, 1);
        assert.deepEqual(await mk().maybeRefresh(), { skipped: 'db-interval' });          // другой инстанс — слот занят
        const [[{ n: n1 }]] = await pool.query('SELECT COUNT(*) n FROM outage_schedules');
        assert.equal(n1, 3);

        await new Promise((r) => setTimeout(r, 1100));
        const r2 = await mk().maybeRefresh({ force: true });                               // без изменений
        assert.equal(r2.yasno.inserted, 0);
        const [[{ n: n2 }]] = await pool.query('SELECT COUNT(*) n FROM outage_schedules');
        assert.equal(n2, 3);
        const [[seen]] = await pool.query("SELECT first_seen_at < last_seen_at AS moved FROM outage_schedules WHERE source='yasno' AND schedule_date='2026-10-09'");
        assert.equal(seen.moved, 1);

        // завтра опубликовали → новая версия; потом откатили → строк не прибавилось, актуальна первая
        yasno = JSON.parse(JSON.stringify(fx('yasno.json')));
        yasno['49.1'].tomorrow = { slots: [{ start: 600, end: 840, type: 'Definite' }], date: '2026-10-10T00:00:00+03:00', status: 'ScheduleApplies' };
        await new Promise((r) => setTimeout(r, 1100));
        assert.equal((await mk().maybeRefresh({ force: true })).yasno.inserted, 1);
        yasno = fx('yasno.json');
        await new Promise((r) => setTimeout(r, 1100));
        assert.equal((await mk().maybeRefresh({ force: true })).yasno.inserted, 1);
        const [[{ n: n3 }]] = await pool.query('SELECT COUNT(*) n FROM outage_schedules');
        assert.equal(n3, 4);

        const q = await a.query({ group: '49.1', startDate: '2026-10-09', endDate: '2026-10-10', versions: true });
        assert.equal(q.days['2026-10-10'].yasno.status, 'WaitingForSchedule');
        assert.equal(q.days['2026-10-10'].yasno.versions.length, 2);
        assert.deepEqual(q.days['2026-10-09'].dtek.slots, [{ start: 0, end: 90, type: 'off' }, { start: 1080, end: 1290, type: 'off' }]);
        assert.equal(q.days['2026-10-09'].yasno.sourceUpdatedAt, '2026-10-09T00:43:15.000Z');
        assert.ok(q.fetchState.yasno.lastOkAt);
    } finally { await pool.end(); }
});
