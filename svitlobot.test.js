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

// Helper to create gridUpdate objects
function makeGridUpdate(state, shouldPing = false) {
    if (state === 'on') {
        return { confirmedPresent: true, isUnknown: false, shouldPingSvitlobot: shouldPing };
    } else if (state === 'off') {
        return { confirmedPresent: false, isUnknown: false, shouldPingSvitlobot: shouldPing };
    } else {
        return { confirmedPresent: null, isUnknown: true, lastConfirmedPresent: null, shouldPingSvitlobot: shouldPing };
    }
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
    assert.deepEqual(await reportToSvitlobot(memPool(), makeGridUpdate('on', true), online, online, online, { key: '' }), { skipped: 'no-key' });
});

test('router reboot: all devices offline → NO PingOff (UNKNOWN state)', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Все устройства офлайн (роутер перезагружается) → unknown, не шлём PingOff
    const gridUpdate = makeGridUpdate('unknown', false);
    await reportToSvitlobot(p, gridUpdate, offline, offline, offline, o);
    const r = await reportToSvitlobot(p, gridUpdate, offline, offline, undefined, o);
    assert.equal(r.reading, 'unknown');
    assert.equal(r.action, 'none');
    assert.equal(calls.length, 0);
});

test('witness relay online → PingOff for both plugs offline (after 2 min)', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Kitchen light online → proves internet works, shouldPingSvitlobot=true (after 2 min debounce)
    const gridUpdate = makeGridUpdate('off', true);
    await reportToSvitlobot(p, gridUpdate, offline, offline, online, o);
    assert.deepEqual(calls, ['channelPingOff']);
});

test('witness switched off but connected qualifies', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Witness relay off (switchOn=false) but online → still qualifies
    const gridUpdate = makeGridUpdate('off', true);
    await reportToSvitlobot(p, gridUpdate, offline, offline, onlineRelayOff, o);
    assert.deepEqual(calls, ['channelPingOff']);
});

test('stale/error witness does not qualify (UNKNOWN)', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Both plugs offline, but witnesses undefined/offline → unknown
    const gridUpdate = makeGridUpdate('unknown', false);
    await reportToSvitlobot(p, gridUpdate, offline, offline, undefined, o);
    assert.equal(calls.length, 0);
    
    await reportToSvitlobot(p, gridUpdate, offline, offline, offline, o);
    assert.equal(calls.length, 0);
});

test('plug online remains ON regardless of witnesses', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Input plug online → ON (even if witnesses offline)
    const gridUpdate = makeGridUpdate('on', true);
    await reportToSvitlobot(p, gridUpdate, online, offline, offline, o);
    const r = await reportToSvitlobot(p, gridUpdate, online, offline, offline, o);
    assert.equal(r.reading, 'on');
    assert.equal(r.action, 'ping-throttled');
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'channelPing');
});

test('first 2 min with witness guard, WITH debounce', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // First minute: both plugs offline + witness online, but shouldPingSvitlobot=false (< 2 min)
    let gridUpdate = makeGridUpdate('off', false);
    await reportToSvitlobot(p, gridUpdate, offline, offline, online, o);
    assert.deepEqual(calls, []); // No PingOff yet
    
    // Second minute: shouldPingSvitlobot=true (>= 2 min)
    gridUpdate = makeGridUpdate('off', true);
    await reportToSvitlobot(p, gridUpdate, offline, offline, online, o);
    assert.deepEqual(calls, ['channelPingOff']);
});

test('no duplicate PingOff per outage', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // First poll after 2 min → PingOff
    const gridUpdate = makeGridUpdate('off', true);
    await reportToSvitlobot(p, gridUpdate, offline, offline, online, o);
    assert.deepEqual(calls, ['channelPingOff']);
    
    // Subsequent polls → no duplicate
    await reportToSvitlobot(p, gridUpdate, offline, offline, online, o);
    await reportToSvitlobot(p, gridUpdate, offline, offline, online, o);
    assert.equal(calls.length, 1);
});

test('recovery after witness-guarded outage', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Outage with witness (after 2 min)
    let gridUpdate = makeGridUpdate('off', true);
    await reportToSvitlobot(p, gridUpdate, offline, offline, online, o);
    assert.deepEqual(calls, ['channelPingOff']);
    
    p.s.now += 120;
    
    // Either plug recovers → channelPing
    gridUpdate = makeGridUpdate('on', true);
    await reportToSvitlobot(p, gridUpdate, online, offline, online, o);
    assert.equal(calls.at(-1), 'channelPing');
});

test('witness online with relay off still considered online → grid present', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Plugs online with relays off + witness relay off → still ON
    const gridUpdate = makeGridUpdate('on', true);
    await reportToSvitlobot(p, gridUpdate, onlineRelayOff, onlineRelayOff, onlineRelayOff, o);
    const r = await reportToSvitlobot(p, gridUpdate, onlineRelayOff, onlineRelayOff, onlineRelayOff, o);
    assert.equal(r.reading, 'on');
    assert.equal(r.action, 'ping-throttled');
    assert.equal(calls.length, 1);
});

test('ping throttled to 60s with witness guard', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Both plugs online → channelPing
    const gridOn = makeGridUpdate('on', true);
    await reportToSvitlobot(p, gridOn, online, online, online, o); p.s.now += 30;
    await reportToSvitlobot(p, gridOn, online, online, online, o); p.s.now += 30;
    await reportToSvitlobot(p, gridOn, online, online, online, o);
    assert.deepEqual(calls, ['channelPing', 'channelPing']);
    
    // Both offline + witness (after 2 min) → PingOff
    const gridOff = makeGridUpdate('off', true);
    await reportToSvitlobot(p, gridOff, offline, offline, online, o);
    assert.deepEqual(calls.slice(2), ['channelPingOff']);
    
    // Recovery
    p.s.now += 120;
    await reportToSvitlobot(p, gridOn, online, online, online, o);
    assert.equal(calls.at(-1), 'channelPing');
});

test('witness online qualifies (after 2 min debounce)', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Kitchen light online (after 2 min)
    const gridOff = makeGridUpdate('off', true);
    await reportToSvitlobot(p, gridOff, offline, offline, online, o);
    assert.deepEqual(calls, ['channelPingOff']);
});

test('PingOff retried on failure with witness guard', async () => {
    const p = memPool(); let n = 0;
    const fetchImpl = async () => { n++; if (n === 1) throw new Error('net'); return { ok: true, status: 200 }; };
    const gridOff = makeGridUpdate('off', true);
    
    await reportToSvitlobot(p, gridOff, offline, offline, online, { key: 'K', fetchImpl });
    assert.equal(n, 1);
    
    // Retry on next poll (off_sent was reset)
    await reportToSvitlobot(p, gridOff, offline, offline, online, { key: 'K', fetchImpl });
    assert.equal(n, 2);
});

test('REGRESSION: witness online confirms internet (after 2 min debounce)', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // Kitchen online + both sockets offline (after 2 min) → OFF (kitchen proves internet)
    const gridOff = makeGridUpdate('off', true);
    await reportToSvitlobot(p, gridOff, offline, offline, online, o);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'channelPingOff');
    
    calls.length = 0;
    p.s.sent = 0;
    
    // Witness offline + both sockets offline → UNKNOWN (cannot prove internet)
    const gridUnknown = makeGridUpdate('unknown', false);
    await reportToSvitlobot(p, gridUnknown, offline, offline, offline, o);
    assert.equal(calls.length, 0);
});

test('UNKNOWN state: continue pinging if last confirmed was ON', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // UNKNOWN but shouldPingSvitlobot=true (last confirmed ON, < 30 min)
    const gridUnknown = makeGridUpdate('unknown', true);
    await reportToSvitlobot(p, gridUnknown, offline, offline, offline, o);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'channelPing');
    assert.equal(calls.length, 1);
});

test('UNKNOWN state: stop pinging if >30 min', async () => {
    const p = memPool(); const calls = [];
    const fetchImpl = async (url) => { calls.push(url.split('?')[0].split('/').pop()); return { ok: true, status: 200 }; };
    const o = { key: 'K', fetchImpl };
    
    // UNKNOWN but shouldPingSvitlobot=false (>30 min or last confirmed OFF)
    const gridUnknown = makeGridUpdate('unknown', false);
    await reportToSvitlobot(p, gridUnknown, offline, offline, offline, o);
    assert.equal(calls.length, 0);
});
