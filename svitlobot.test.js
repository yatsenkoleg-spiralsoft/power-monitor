const test = require('node:test');
const assert = require('node:assert');
const { reportToSvitlobot, aggregateReadings } = require('./svitlobot');

function memPool() {
    const s = { last: null, sent: 0, now: 1000 };
    return { s, async execute(sql) {
        if (/^CREATE|^INSERT/.test(sql)) return [{}];
        if (/SET last_ping_at/.test(sql)) { if (s.last === null || s.last <= s.now - 60) { s.last = s.now; return [{ affectedRows: 1 }]; } return [{ affectedRows: 0 }]; }
        if (/off_sent = 0/.test(sql) && !/WHERE id = 1 AND off_sent = 0/.test(sql)) { s.sent = 0; return [{}]; }
        if (/SET off_sent = 1.*WHERE id = 1 AND off_sent = 0/.test(sql)) { if (!s.sent) { s.sent = 1; return [{ affectedRows: 1 }]; } return [{ affectedRows: 0 }]; }
        return [{}];
    } };
}

// Device connectivity states (isOnline is the key field)
const online = { isOnline: true, voltageV: 230, switchOn: true, powerConsumptionW: 100 };
const onlineRelayOff = { isOnline: true, voltageV: 0, switchOn: false, powerConsumptionW: 0 };
const onlineNoVoltage = { isOnline: true, voltageV: 0, switchOn: true, powerConsumptionW: 0 };
const offline = { isOnline: false, voltageV: null, switchOn: null, powerConsumptionW: null };

test('aggregate: at least one online → on; both explicitly offline → off', () => {
    // Хотя бы одно устройство онлайн → 'on' (даже если реле выключено или 0В)
    assert.equal(aggregateReadings(online, online), 'on');
    assert.equal(aggregateReadings(online, offline), 'on');
    assert.equal(aggregateReadings(offline, online), 'on');
    assert.equal(aggregateReadings(onlineRelayOff, offline), 'on');
    assert.equal(aggregateReadings(offline, onlineRelayOff), 'on');
    assert.equal(aggregateReadings(onlineNoVoltage, offline), 'on');
    assert.equal(aggregateReadings(offline, onlineNoVoltage), 'on');
    assert.equal(aggregateReadings(onlineRelayOff, onlineNoVoltage), 'on');
    assert.equal(aggregateReadings(online, undefined), 'on');
    assert.equal(aggregateReadings(undefined, online), 'on');
    
    // ОБЕ явно offline (isOnline=false) → 'off'
    assert.equal(aggregateReadings(offline, offline), 'off');
    
    // Undefined/null/ошибки → unknown
    assert.equal(aggregateReadings(undefined, undefined), 'unknown');
    assert.equal(aggregateReadings(null, null), 'unknown');
    assert.equal(aggregateReadings(offline, undefined), 'unknown');
    assert.equal(aggregateReadings(undefined, offline), 'unknown');
    assert.equal(aggregateReadings({}, {}), 'unknown');
    assert.equal(aggregateReadings({ isOnline: null }, { isOnline: null }), 'unknown');
});

test('no key → no-op', async () => {
    assert.deepEqual(await reportToSvitlobot(memPool(), online, online, { key: '' }), { skipped: 'no-key' });
});

test('ping throttled to 60s, PingOff immediately when both offline', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Both online → channelPing
    await reportToSvitlobot(p, online, online, o); p.s.now += 30;
    await reportToSvitlobot(p, online, online, o); p.s.now += 30;
    await reportToSvitlobot(p, online, online, o);
    assert.deepEqual(calls, ['channelPing', 'channelPing']);
    
    // Both offline → PingOff immediately (first poll)
    await reportToSvitlobot(p, offline, offline, o);
    assert.deepEqual(calls.slice(2), ['channelPingOff']);
    
    // Recovery: any one online → channelPing
    p.s.now += 120;
    await reportToSvitlobot(p, online, online, o);
    assert.equal(calls.at(-1), 'channelPing');
});

test('online with relay off still considered online → grid present', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Both online but relays off → still 'on'
    await reportToSvitlobot(p, onlineRelayOff, onlineRelayOff, o);
    const r = await reportToSvitlobot(p, onlineRelayOff, onlineRelayOff, o);
    assert.equal(r.reading, 'on');
    assert.equal(r.action, 'ping-throttled');
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'channelPing');
});

test('one online relay off, other offline → still grid present', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    await reportToSvitlobot(p, onlineRelayOff, offline, o);
    const r = await reportToSvitlobot(p, onlineRelayOff, offline, o);
    assert.equal(r.reading, 'on');
    assert.equal(r.action, 'ping-throttled');
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'channelPing');
});

test('both offline one poll sends PingOff immediately', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // First poll with both offline → immediate PingOff
    await reportToSvitlobot(p, offline, offline, o);
    assert.deepEqual(calls, ['channelPingOff']);
});

test('repeated both offline no duplicate PingOff', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // First poll → PingOff
    await reportToSvitlobot(p, offline, offline, o);
    assert.deepEqual(calls, ['channelPingOff']);
    
    // Subsequent polls → no duplicate
    await reportToSvitlobot(p, offline, offline, o);
    await reportToSvitlobot(p, offline, offline, o);
    assert.equal(calls.length, 1);
});

test('either device online restoration sends channelPing', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Both offline → PingOff
    await reportToSvitlobot(p, offline, offline, o);
    assert.deepEqual(calls, ['channelPingOff']);
    
    p.s.now += 120;
    
    // Input restores, kitchen still offline → channelPing
    await reportToSvitlobot(p, online, offline, o);
    assert.equal(calls.at(-1), 'channelPing');
    
    // Both offline again
    await reportToSvitlobot(p, offline, offline, o);
    assert.equal(calls.at(-1), 'channelPingOff');
    
    p.s.now += 120;
    
    // Kitchen restores, input offline → channelPing
    await reportToSvitlobot(p, offline, online, o);
    assert.equal(calls.at(-1), 'channelPing');
});

test('incomplete/error poll (undefined) does not send false PingOff', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Both undefined (API errors) → no PingOff
    await reportToSvitlobot(p, undefined, undefined, o);
    assert.equal(calls.length, 0);
    
    // One undefined, one offline → no PingOff
    await reportToSvitlobot(p, undefined, offline, o);
    assert.equal(calls.length, 0);
    
    await reportToSvitlobot(p, offline, undefined, o);
    assert.equal(calls.length, 0);
    
    // Both online after errors → channelPing
    await reportToSvitlobot(p, online, online, o);
    assert.deepEqual(calls, ['channelPing']);
});

test('null/missing isOnline field does not synthesize offline', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // isOnline missing/null → unknown, not offline
    await reportToSvitlobot(p, { isOnline: null }, { isOnline: null }, o);
    assert.equal(calls.length, 0);
    
    await reportToSvitlobot(p, {}, {}, o);
    assert.equal(calls.length, 0);
});

test('online with 0V/0W still online → no false offline', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Both online but 0V → still online
    await reportToSvitlobot(p, onlineNoVoltage, onlineNoVoltage, o);
    const r = await reportToSvitlobot(p, onlineNoVoltage, onlineNoVoltage, o);
    assert.equal(r.reading, 'on');
    assert.equal(r.action, 'ping-throttled');
    assert.equal(calls.length, 1);
});

test('all permutations: one online with any other state → on', async () => {
    const p = memPool();
    const fetchImpl = async () => ({ ok: true, status: 200 });
    const o = { key: 'K', fetchImpl };
    
    const states = [
        [online, online, 'on'],
        [online, onlineRelayOff, 'on'],
        [online, onlineNoVoltage, 'on'],
        [online, offline, 'on'],
        [online, undefined, 'on'],
        [onlineRelayOff, online, 'on'],
        [onlineRelayOff, offline, 'on'],
        [onlineNoVoltage, online, 'on'],
        [onlineNoVoltage, offline, 'on'],
        [offline, online, 'on'],
        [offline, onlineRelayOff, 'on'],
        [offline, onlineNoVoltage, 'on'],
        [undefined, online, 'on'],
    ];
    
    for (const [input, kitchen, expected] of states) {
        const r = await reportToSvitlobot(p, input, kitchen, o);
        assert.equal(r.reading, expected, `Failed for ${JSON.stringify({input: input?.isOnline, kitchen: kitchen?.isOnline})}`);
        p.s.now += 120;
    }
});

test('PingOff retried on failure, errors never thrown', async () => {
    const p = memPool(); let n = 0;
    const fetchImpl = async () => { n++; if (n === 1) throw new Error('net'); return { ok: true, status: 200 }; };
    
    await reportToSvitlobot(p, offline, offline, { key: 'K', fetchImpl });
    assert.equal(n, 1);
    
    // Retry on next poll (off_sent was reset)
    await reportToSvitlobot(p, offline, offline, { key: 'K', fetchImpl });
    assert.equal(n, 2);
});
