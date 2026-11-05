const test = require('node:test');
const assert = require('node:assert');
const { reportToSvitlobot, classifyReading, aggregateReadings } = require('./svitlobot');

function memPool() {
    const s = { last: null, streak: 0, sent: 0, now: 1000 };
    return { s, async execute(sql) {
        if (/^CREATE|^INSERT/.test(sql)) return [{}];
        if (/SET last_ping_at/.test(sql)) { if (s.last === null || s.last <= s.now - 60) { s.last = s.now; return [{ affectedRows: 1 }]; } return [{ affectedRows: 0 }]; }
        if (/off_streak = 0, off_sent = 0/.test(sql)) { s.streak = 0; s.sent = 0; return [{}]; }
        if (/off_streak \+ 1/.test(sql)) { s.streak++; return [{}]; }
        if (/SET off_sent = 1/.test(sql)) { if (!s.sent && s.streak >= 2) { s.sent = 1; return [{ affectedRows: 1 }]; } return [{ affectedRows: 0 }]; }
        if (/SET off_sent = 0/.test(sql)) { s.sent = 0; return [{}]; }
        if (/off_streak = 0/.test(sql)) { s.streak = 0; return [{}]; }
        throw new Error('unexpected ' + sql);
    } };
}
const on = { isOnline: true, voltageV: 230 }, off = { isOnline: true, voltageV: 0 }, unreach = { isOnline: false, voltageV: null };

test('classify', () => {
    assert.equal(classifyReading(on), 'on'); assert.equal(classifyReading(off), 'off'); assert.equal(classifyReading(unreach), 'off'); assert.equal(classifyReading(undefined), 'off'); assert.equal(classifyReading({ isOnline: true, voltageV: null }), 'unknown');
});

test('aggregate: both same → status; any mismatch → mismatch', () => {
    assert.equal(aggregateReadings(['on', 'on']), 'on');
    assert.equal(aggregateReadings(['off', 'off']), 'off');
    assert.equal(aggregateReadings(['on', 'off']), 'mismatch');
    assert.equal(aggregateReadings(['off', 'on']), 'mismatch');
    assert.equal(aggregateReadings(['on', 'unknown']), 'mismatch');
    assert.equal(aggregateReadings(['off', 'unknown']), 'mismatch');
    assert.equal(aggregateReadings(['unknown', 'on']), 'mismatch');
    assert.equal(aggregateReadings(['unknown', 'off']), 'mismatch');
    assert.equal(aggregateReadings(['unknown', 'unknown']), 'mismatch');
    assert.equal(aggregateReadings([]), 'mismatch');
    assert.equal(aggregateReadings(['on']), 'mismatch');
});

test('no key → no-op', async () => {
    assert.deepEqual(await reportToSvitlobot(memPool(), on, on, { key: '' }), { skipped: 'no-key' });
});

test('ping throttled to 60 s, PingOff once after 2 polls with both off', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    await reportToSvitlobot(p, on, on, o); p.s.now += 30;
    await reportToSvitlobot(p, on, on, o); p.s.now += 30;
    await reportToSvitlobot(p, on, on, o);
    assert.deepEqual(calls, ['channelPing', 'channelPing']);
    await reportToSvitlobot(p, unreach, unreach, o);
    assert.equal(calls.length, 2);
    await reportToSvitlobot(p, off, off, o);
    assert.deepEqual(calls.slice(2), ['channelPingOff']);
    p.s.now += 120; await reportToSvitlobot(p, on, on, o);
    assert.equal(calls.at(-1), 'channelPing');
});

test('input offline, kitchen powered → mismatch, no requests', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    await reportToSvitlobot(p, unreach, on, o);
    const r = await reportToSvitlobot(p, unreach, on, o);
    assert.equal(r.reading, 'mismatch');
    assert.equal(r.action, 'mismatch');
    assert.equal(calls.length, 0);
});

test('kitchen offline, input powered → mismatch, no requests', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    await reportToSvitlobot(p, on, unreach, o);
    const r = await reportToSvitlobot(p, on, unreach, o);
    assert.equal(r.reading, 'mismatch');
    assert.equal(r.action, 'mismatch');
    assert.equal(calls.length, 0);
});

test('both offline across 2 polls → PingOff', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    await reportToSvitlobot(p, off, off, o);
    await reportToSvitlobot(p, unreach, unreach, o);
    assert.deepEqual(calls, ['channelPingOff']);
});

test('recovery requires BOTH sockets on, not single restore', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    await reportToSvitlobot(p, off, off, o);
    await reportToSvitlobot(p, off, off, o);
    assert.deepEqual(calls, ['channelPingOff']);
    p.s.now += 120;
    await reportToSvitlobot(p, off, on, o);
    assert.equal(calls.length, 1);
    assert.equal(calls.at(-1), 'channelPingOff');
    await reportToSvitlobot(p, on, off, o);
    assert.equal(calls.length, 1);
    await reportToSvitlobot(p, on, on, o);
    assert.equal(calls.at(-1), 'channelPing');
});

test('missing/stale readings (undefined) treated as off', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    await reportToSvitlobot(p, undefined, undefined, o);
    await reportToSvitlobot(p, undefined, undefined, o);
    assert.deepEqual(calls, ['channelPingOff']);
});

test('mismatch breaks debounce: unknown resets streak', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    const unknownSocket = { isOnline: true, voltageV: null };
    await reportToSvitlobot(p, off, off, o);
    await reportToSvitlobot(p, unknownSocket, unknownSocket, o);
    assert.equal(calls.length, 0);
    assert.equal(p.s.streak, 0);
});

test('agreement restoration: both on after mismatch → channelPing', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    await reportToSvitlobot(p, on, off, o);
    assert.equal(calls.length, 0);
    await reportToSvitlobot(p, on, on, o);
    assert.deepEqual(calls, ['channelPing']);
});

test('agreement restoration: both off after mismatch starts new debounce', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    await reportToSvitlobot(p, on, off, o);
    await reportToSvitlobot(p, off, off, o);
    assert.equal(calls.length, 0);
    assert.equal(p.s.streak, 1);
    await reportToSvitlobot(p, off, off, o);
    assert.deepEqual(calls, ['channelPingOff']);
});

test('debounce broken by mismatch: off → off → mismatch → off → off', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    await reportToSvitlobot(p, off, off, o);
    assert.equal(p.s.streak, 1);
    await reportToSvitlobot(p, on, off, o);
    assert.equal(p.s.streak, 0);
    assert.equal(calls.length, 0);
    await reportToSvitlobot(p, off, off, o);
    assert.equal(p.s.streak, 1);
    await reportToSvitlobot(p, off, off, o);
    assert.deepEqual(calls, ['channelPingOff']);
});

test('PingOff retried on failure, errors never thrown', async () => {
    const p = memPool(); let n = 0;
    const fetchImpl = async () => { n++; if (n === 1) throw new Error('net'); return { ok: true, status: 200 }; };
    for (let i = 0; i < 4; i++) await reportToSvitlobot(p, off, off, { key: 'K', fetchImpl });
    assert.equal(n, 2);
});
