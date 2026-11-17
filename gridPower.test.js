const test = require('node:test');
const assert = require('node:assert');
const { determineGridState, computeGridPresent, GRID_VOLTAGE_THRESHOLD } = require('./gridPower');

// Device states
const online = { isOnline: true, voltageV: 230 };
const onlineNoVoltage = { isOnline: true, voltageV: 0 };
const onlineLowVoltage = { isOnline: true, voltageV: 30 };
const offline = { isOnline: false, voltageV: null };
const witnessOnline = { isOnline: true };
const witnessOffline = { isOnline: false };

test('determineGridState: at least one socket online -> PRESENT', () => {
    // Both sockets online
    assert.equal(determineGridState(online, online, witnessOnline), 'present');
    assert.equal(determineGridState(online, online, witnessOffline), 'present');
    assert.equal(determineGridState(online, online, undefined), 'present');
    
    // Only socket1 online
    assert.equal(determineGridState(online, offline, witnessOnline), 'present');
    assert.equal(determineGridState(online, offline, witnessOffline), 'present');
    assert.equal(determineGridState(online, offline, undefined), 'present');
    
    // Only socket2 online
    assert.equal(determineGridState(offline, online, witnessOnline), 'present');
    assert.equal(determineGridState(offline, online, witnessOffline), 'present');
    assert.equal(determineGridState(offline, online, undefined), 'present');
});

test('determineGridState: one socket online with low voltage -> ABSENT', () => {
    // Socket online but voltage below threshold
    assert.equal(determineGridState(onlineLowVoltage, offline, witnessOnline), 'absent');
    assert.equal(determineGridState(offline, onlineLowVoltage, witnessOnline), 'absent');
    assert.equal(determineGridState(onlineNoVoltage, offline, witnessOffline), 'absent');
});

test('determineGridState: both sockets offline + witness online -> ABSENT', () => {
    assert.equal(determineGridState(offline, offline, witnessOnline), 'absent');
});

test('determineGridState: both sockets offline + witness offline -> UNKNOWN', () => {
    assert.equal(determineGridState(offline, offline, witnessOffline), 'unknown');
    assert.equal(determineGridState(offline, offline, undefined), 'unknown');
});

test('determineGridState: undefined/null inputs -> UNKNOWN', () => {
    assert.equal(determineGridState(undefined, undefined, witnessOnline), 'unknown');
    assert.equal(determineGridState(undefined, offline, witnessOnline), 'unknown');
    assert.equal(determineGridState(null, null, witnessOnline), 'unknown');
});

test('determineGridState: witness online even with relay off qualifies', () => {
    const witnessRelayOff = { isOnline: true, switchOn: false };
    assert.equal(determineGridState(offline, offline, witnessRelayOff), 'absent');
});

test('determineGridState: socket online without voltage data -> PRESENT', () => {
    const socketOnlineNoData = { isOnline: true, voltageV: null };
    assert.equal(determineGridState(socketOnlineNoData, offline, witnessOnline), 'present');
    assert.equal(determineGridState(offline, socketOnlineNoData, witnessOnline), 'present');
});

test('legacy computeGridPresent: backward compatibility', () => {
    // Socket online with good voltage
    assert.equal(computeGridPresent(true, 230), true);
    
    // Socket online with low voltage
    assert.equal(computeGridPresent(true, 30), false);
    
    // Socket offline
    assert.equal(computeGridPresent(false, 230), false);
    assert.equal(computeGridPresent(false, null), false);
    
    // Socket online but no voltage data
    assert.equal(computeGridPresent(true, null), null);
    assert.equal(computeGridPresent(true, undefined), null);
    assert.equal(computeGridPresent(true, NaN), null);
});

test('REGRESSION: single socket Wi-Fi drop should not trigger outage', () => {
    // Socket1 online, socket2 offline -> PRESENT (socket2's Wi-Fi might have dropped)
    assert.equal(determineGridState(online, offline, witnessOnline), 'present');
    assert.equal(determineGridState(online, offline, witnessOffline), 'present');
    
    // Socket1 offline, socket2 online -> PRESENT (socket1's Wi-Fi might have dropped)
    assert.equal(determineGridState(offline, online, witnessOnline), 'present');
    assert.equal(determineGridState(offline, online, witnessOffline), 'present');
});

test('REGRESSION: internet outage (all devices offline) should return UNKNOWN', () => {
    // All devices offline (router down scenario from 2026-11-17)
    assert.equal(determineGridState(offline, offline, witnessOffline), 'unknown');
    assert.equal(determineGridState(offline, offline, undefined), 'unknown');
});

test('REGRESSION: real outage with witness proves internet works', () => {
    // Both sockets offline but witness online -> proves internet works, power is really out
    assert.equal(determineGridState(offline, offline, witnessOnline), 'absent');
});
