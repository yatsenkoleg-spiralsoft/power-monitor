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

test('aggregate: plug online → on; both plugs offline + witness online → off', () => {
    // Хотя бы одна розетка онлайн → 'on' (witness не влияет)
    assert.equal(aggregateReadings(online, online, offline, offline), 'on');
    assert.equal(aggregateReadings(online, offline, online, undefined), 'on');
    assert.equal(aggregateReadings(offline, online, undefined, undefined), 'on');
    
    // ОБЕ розетки offline + хотя бы один witness online → 'off' (интернет работает)
    assert.equal(aggregateReadings(offline, offline, online, offline), 'off');
    assert.equal(aggregateReadings(offline, offline, offline, online), 'off');
    assert.equal(aggregateReadings(offline, offline, online, online), 'off');
    assert.equal(aggregateReadings(offline, offline, onlineRelayOff, undefined), 'off');
    
    // ОБЕ розетки offline БЕЗ онлайн witness → 'unknown' (возможна перезагрузка роутера)
    assert.equal(aggregateReadings(offline, offline, offline, offline), 'unknown');
    assert.equal(aggregateReadings(offline, offline, undefined, undefined), 'unknown');
    assert.equal(aggregateReadings(offline, offline, undefined, offline), 'unknown');
    
    // API errors / undefined → unknown
    assert.equal(aggregateReadings(undefined, undefined, online, online), 'unknown');
    assert.equal(aggregateReadings(undefined, offline, online, online), 'unknown');
});

test('no key → no-op', async () => {
    assert.deepEqual(await reportToSvitlobot(memPool(), online, online, online, online, { key: '' }), { skipped: 'no-key' });
});

test('router reboot: all 4 devices offline → NO PingOff', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Все устройства офлайн (роутер перезагружается) → unknown, не шлём PingOff
    await reportToSvitlobot(p, offline, offline, offline, offline, o);
    const r = await reportToSvitlobot(p, offline, offline, undefined, undefined, o);
    assert.equal(r.reading, 'unknown');
    assert.equal(r.action, 'none');
    assert.equal(calls.length, 0);
});

test('witness relay online → PingOff for both plugs offline', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Kitchen light online → proves internet works
    await reportToSvitlobot(p, offline, offline, online, undefined, o);
    assert.deepEqual(calls, ['channelPingOff']);
    
    calls.length = 0;
    p.s.sent = 0;
    
    // Corridor light online → proves internet works
    await reportToSvitlobot(p, offline, offline, undefined, online, o);
    assert.deepEqual(calls, ['channelPingOff']);
});

test('witness switched off but connected qualifies', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Witness relay off (switchOn=false) but online → still qualifies
    await reportToSvitlobot(p, offline, offline, onlineRelayOff, undefined, o);
    assert.deepEqual(calls, ['channelPingOff']);
});

test('stale/error witness does not qualify', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Both plugs offline, but witnesses undefined/offline → unknown
    await reportToSvitlobot(p, offline, offline, undefined, undefined, o);
    assert.equal(calls.length, 0);
    
    await reportToSvitlobot(p, offline, offline, offline, offline, o);
    assert.equal(calls.length, 0);
});

test('plug online remains ON regardless of witnesses', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Input plug online → ON (even if witnesses offline)
    await reportToSvitlobot(p, online, offline, offline, offline, o);
    const r = await reportToSvitlobot(p, online, offline, offline, offline, o);
    assert.equal(r.reading, 'on');
    assert.equal(r.action, 'ping-throttled');
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'channelPing');
});

test('first poll with witness guard, no debounce', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // First poll: both plugs offline + witness online → immediate PingOff
    await reportToSvitlobot(p, offline, offline, online, undefined, o);
    assert.deepEqual(calls, ['channelPingOff']);
});

test('no duplicate PingOff per outage', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // First poll → PingOff
    await reportToSvitlobot(p, offline, offline, online, undefined, o);
    assert.deepEqual(calls, ['channelPingOff']);
    
    // Subsequent polls → no duplicate
    await reportToSvitlobot(p, offline, offline, online, undefined, o);
    await reportToSvitlobot(p, offline, offline, online, undefined, o);
    assert.equal(calls.length, 1);
});

test('recovery after witness-guarded outage', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Outage with witness
    await reportToSvitlobot(p, offline, offline, online, undefined, o);
    assert.deepEqual(calls, ['channelPingOff']);
    
    p.s.now += 120;
    
    // Either plug recovers → channelPing
    await reportToSvitlobot(p, online, offline, online, undefined, o);
    assert.equal(calls.at(-1), 'channelPing');
});

test('witness online with relay off still considered online → grid present', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Plugs online with relays off + witness relay off → still ON
    await reportToSvitlobot(p, onlineRelayOff, onlineRelayOff, onlineRelayOff, undefined, o);
    const r = await reportToSvitlobot(p, onlineRelayOff, onlineRelayOff, onlineRelayOff, undefined, o);
    assert.equal(r.reading, 'on');
    assert.equal(r.action, 'ping-throttled');
    assert.equal(calls.length, 1);
});

test('ping throttled to 60s with witness guard', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Both plugs online → channelPing
    await reportToSvitlobot(p, online, online, online, online, o); p.s.now += 30;
    await reportToSvitlobot(p, online, online, online, online, o); p.s.now += 30;
    await reportToSvitlobot(p, online, online, online, online, o);
    assert.deepEqual(calls, ['channelPing', 'channelPing']);
    
    // Both offline + witness → PingOff
    await reportToSvitlobot(p, offline, offline, online, undefined, o);
    assert.deepEqual(calls.slice(2), ['channelPingOff']);
    
    // Recovery
    p.s.now += 120;
    await reportToSvitlobot(p, online, online, online, online, o);
    assert.equal(calls.at(-1), 'channelPing');
});

test('either witness qualifies independently', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Kitchen light only
    await reportToSvitlobot(p, offline, offline, online, offline, o);
    assert.deepEqual(calls, ['channelPingOff']);
    
    calls.length = 0;
    p.s.sent = 0;
    
    // Corridor light only
    await reportToSvitlobot(p, offline, offline, offline, online, o);
    assert.deepEqual(calls, ['channelPingOff']);
    
    calls.length = 0;
    p.s.sent = 0;
    
    // Both witnesses
    await reportToSvitlobot(p, offline, offline, online, online, o);
    assert.deepEqual(calls, ['channelPingOff']);
});

test('PingOff retried on failure with witness guard', async () => {
    const p = memPool(); let n = 0;
    const fetchImpl = async () => { n++; if (n === 1) throw new Error('net'); return { ok: true, status: 200 }; };
    
    await reportToSvitlobot(p, offline, offline, online, undefined, { key: 'K', fetchImpl });
    assert.equal(n, 1);
    
    // Retry on next poll (off_sent was reset)
    await reportToSvitlobot(p, offline, offline, online, undefined, { key: 'K', fetchImpl });
    assert.equal(n, 2);
});

test('REGRESSION: dual witness logic - either kitchen OR corridor online confirms internet', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Kitchen only online + both sockets offline → OFF (kitchen proves internet)
    await reportToSvitlobot(p, offline, offline, online, offline, o);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'channelPingOff');
    
    calls.length = 0;
    p.s.sent = 0;
    
    // Corridor only online + both sockets offline → OFF (corridor proves internet)
    await reportToSvitlobot(p, offline, offline, offline, online, o);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'channelPingOff');
    
    calls.length = 0;
    p.s.sent = 0;
    
    // Both witnesses offline + both sockets offline → UNKNOWN (cannot prove internet)
    await reportToSvitlobot(p, offline, offline, offline, offline, o);
    assert.equal(calls.length, 0);
});
