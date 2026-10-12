'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const zlib = require('node:zlib');
const q = require('../minuteQuery');
const { gzipJson } = require('../gzipJson');

test('Kyiv day bounds in UTC (summer, winter, DST switch days)', () => {
    assert.deepStrictEqual(q.kyivDateRangeUtc('2026-10-10', '2026-10-10'),
        { fromUtc: '2026-10-09 21:00:00', toUtc: '2026-10-10 21:00:00' });
    assert.deepStrictEqual(q.kyivDateRangeUtc('2026-01-15', '2026-01-15'),
        { fromUtc: '2026-01-14 22:00:00', toUtc: '2026-01-15 22:00:00' });
    // 2026-10-25: переход на зимнее время (сутки 25 часов)
    assert.deepStrictEqual(q.kyivDateRangeUtc('2026-10-25', '2026-10-25'),
        { fromUtc: '2026-10-24 21:00:00', toUtc: '2026-10-25 22:00:00' });
    // 2026-03-29: переход на летнее время (сутки 23 часа)
    assert.deepStrictEqual(q.kyivDateRangeUtc('2026-03-29', '2026-03-29'),
        { fromUtc: '2026-03-28 22:00:00', toUtc: '2026-03-29 21:00:00' });
    // 7 дней
    assert.deepStrictEqual(q.kyivDateRangeUtc('2026-10-03', '2026-10-10'),
        { fromUtc: '2026-10-02 21:00:00', toUtc: '2026-10-10 21:00:00' });
    // конец месяца/года
    assert.deepStrictEqual(q.kyivDateRangeUtc('2026-12-31', '2026-12-31'),
        { fromUtc: '2026-12-30 22:00:00', toUtc: '2026-12-31 22:00:00' });
});

test('date validation', () => {
    assert.ok(q.isValidDate('2026-10-10'));
    assert.ok(!q.isValidDate('2026-02-30'));
    assert.ok(!q.isValidDate('2026-10-10; DROP'));
    assert.ok(!q.isValidDate(undefined));
});

test('fields projection', () => {
    assert.strictEqual(q.parseFields(undefined), null);
    assert.strictEqual(q.parseFields('nope'), null);
    assert.deepStrictEqual(q.parseFields('avg_power_w, is_online,bogus'), ['minute', 'avg_power_w', 'is_online']);
    const rows = [{ minute: 'm', avg_power_w: '1.00', is_online: 1, device_name: 'x' }];
    assert.deepStrictEqual(q.projectRows(rows, ['minute', 'is_online']), [{ minute: 'm', is_online: 1 }]);
    assert.strictEqual(q.projectRows(rows, null), rows);
});

function serve(handler) {
    return new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
            res.set = (k, v) => res.setHeader(k, v);
            res.append = (k, v) => res.setHeader(k, v);
            res.json = (body) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); return res; };
            gzipJson(req, res, () => handler(req, res));
        });
        srv.listen(0, () => resolve(srv));
    });
}

function get(port, headers) {
    return new Promise((resolve, reject) => {
        http.get({ port, path: '/', headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
        }).on('error', reject);
    });
}

test('gzipJson compresses large bodies only when accepted', async () => {
    const big = { success: true, data: Array.from({ length: 500 }, (_, i) => ({ minute: `2026-10-10 ${i}`, v: 1 })) };
    const srv = await serve((req, res) => res.json(big));
    const port = srv.address().port;
    try {
        const gz = await get(port, { 'accept-encoding': 'gzip, deflate' });
        assert.strictEqual(gz.headers['content-encoding'], 'gzip');
        assert.deepStrictEqual(JSON.parse(zlib.gunzipSync(gz.body)), big);
        assert.ok(gz.body.length < JSON.stringify(big).length / 5);
        const plain = await get(port, {});
        assert.strictEqual(plain.headers['content-encoding'], undefined);
        assert.deepStrictEqual(JSON.parse(plain.body), big);
    } finally { srv.close(); }
});

test('gzipJson leaves small bodies alone', async () => {
    const srv = await serve((req, res) => res.json({ ok: 1 }));
    try {
        const r = await get(srv.address().port, { 'accept-encoding': 'gzip' });
        assert.strictEqual(r.headers['content-encoding'], undefined);
        assert.deepStrictEqual(JSON.parse(r.body), { ok: 1 });
    } finally { srv.close(); }
});
