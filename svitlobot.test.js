const test = require('node:test');
const assert = require('node:assert');
const { reportToSvitlobot, classifyReading } = require('./svitlobot');

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
test('no key → no-op', async () => {
    assert.deepEqual(await reportToSvitlobot(memPool(), on, { key: '' }), { skipped: 'no-key' });
});
test('ping throttled to 60 s, PingOff once after 2 no-power polls (offline or <50V)', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    await reportToSvitlobot(p, on, o); p.s.now += 30;
    await reportToSvitlobot(p, on, o); p.s.now += 30;
    await reportToSvitlobot(p, on, o);
    assert.deepEqual(calls, ['channelPing', 'channelPing']);
    await reportToSvitlobot(p, unreach, o);
    assert.equal(calls.length, 2); // один опрос без света — ещё не отключение
    await reportToSvitlobot(p, off, o); // офлайн + <50 В подряд = 2 опроса
    await reportToSvitlobot(p, unreach, o); await reportToSvitlobot(p, off, o);
    assert.deepEqual(calls.slice(2), ['channelPingOff']); // ровно один раз
    p.s.now += 120; await reportToSvitlobot(p, on, o);
    assert.equal(calls.at(-1), 'channelPing');
});
test('PingOff retried on failure, errors never thrown', async () => {
    const p = memPool(); let n = 0;
    const fetchImpl = async () => { n++; if (n === 1) throw new Error('net'); return { ok: true, status: 200 }; };
    for (let i = 0; i < 4; i++) await reportToSvitlobot(p, off, { key: 'K', fetchImpl });
    assert.equal(n, 2);
});
