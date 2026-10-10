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
