const test = require('node:test');
const assert = require('node:assert/strict');
const { flattenQuotaMessage, maskSn, kickAndCollect } = require('../ecoflowMqtt');

test('flattenQuotaMessage: typeCode → префикс как в /quota/all', () => {
    assert.deepEqual(
        flattenQuotaMessage({ typeCode: 'pdStatus', params: { soc: 92, wattsInSum: 1238, nested: { a: 1 } } }),
        { 'pd.soc': 92, 'pd.wattsInSum': 1238 }
    );
    assert.deepEqual(flattenQuotaMessage({ typeCode: 'invStatus', params: { acInVol: 226436 } }), { 'inv.acInVol': 226436 });
    assert.deepEqual(flattenQuotaMessage({ typeCode: 'bmsStatus', params: { soc: 91 } }), { 'bms_bmsStatus.soc': 91 });
});

test('flattenQuotaMessage: ключи уже с точкой берутся как есть, неизвестный формат — пусто', () => {
    assert.deepEqual(flattenQuotaMessage({ params: { 'pd.soc': 77 } }), { 'pd.soc': 77 });
    assert.deepEqual(flattenQuotaMessage({ typeCode: 'unknown', params: { soc: 1 } }), {});
    assert.deepEqual(flattenQuotaMessage(null), {});
    assert.deepEqual(flattenQuotaMessage({ foo: 1 }), {});
});

test('maskSn не раскрывает серийник целиком', () => {
    assert.equal(maskSn('R351ABCDEFG135'), 'R351…135');
});

test('kickAndCollect не бросает исключений при ошибке учётки', async () => {
    const rest = { getMqttCredentials: async () => { throw new Error('boom'); } };
    const r = await kickAndCollect(rest, ['SN1'], { waitMs: 10, force: true });
    assert.equal(r.size, 0);
});

test('kickAndCollect отключается env ECOFLOW_MQTT_KICK=0', async () => {
    process.env.ECOFLOW_MQTT_KICK = '0';
    try {
        let called = false;
        const rest = { getMqttCredentials: async () => { called = true; return {}; } };
        const r = await kickAndCollect(rest, ['SN1'], { force: true });
        assert.equal(r.size, 0);
        assert.equal(called, false);
    } finally {
        delete process.env.ECOFLOW_MQTT_KICK;
    }
});

test('kickAndCollect: второй пинок раньше интервала (по умолчанию 10 мин) пропускается', async () => {
    let calls = 0;
    const rest = { getMqttCredentials: async () => { calls += 1; throw new Error('no broker'); } };
    await kickAndCollect(rest, ['SN1'], { waitMs: 10, force: true });
    await kickAndCollect(rest, ['SN1'], { waitMs: 10 });
    assert.equal(calls, 1);
});


// --- reauth helpers ---
{
    const nt = require('node:test'); const assert = require('node:assert');
    const m = require('../ecoflowMqtt');
    nt.test('isAuthError', () => {
        assert.ok(m.isAuthError(new Error('Connection refused: Not authorized')));
        assert.ok(m.isAuthError(new Error('Connection refused: Bad username or password')));
        assert.ok(!m.isAuthError(new Error('connect timeout')));
    });
    nt.test('buildClientId is stable and account-prefixed', () => {
        assert.strictEqual(m.buildClientId('open-abc', ''), 'open-abc_roz-pm');
        assert.strictEqual(m.buildClientId('open-abc', ''), m.buildClientId('open-abc', ''));
        assert.strictEqual(m.buildClientId('open-abc', 'x1'), 'x1');
    });
    nt.test('authBackoffMs grows and caps', () => {
        const b = 10 * 60000;
        assert.strictEqual(m.authBackoffMs(0, b), 0);
        assert.strictEqual(m.authBackoffMs(1, b), b);
        assert.strictEqual(m.authBackoffMs(3, b), 4 * b);
        assert.strictEqual(m.authBackoffMs(20, b), 6 * 3600 * 1000);
    });
    nt.test('kickAndCollect re-fetches certification once on auth error', async () => {
        let calls = 0;
        const rc = { getMqttCredentials: async () => { calls++; return { certificateAccount: 'open-x', certificatePassword: 'p', url: '127.0.0.1', port: 1, protocol: 'mqtt' }; } };
        await m.kickAndCollect(rc, ['SN1'], { waitMs: 10, force: true });
        assert.ok(calls >= 1);
    });
}
