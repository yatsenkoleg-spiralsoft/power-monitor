/* Запуск: node --test test/   — без сети/MySQL/Firebase. */
const test = require('node:test');
const assert = require('node:assert/strict');
const SP = require('../schedulePush');

const day = (yasno, dtek) => ({ ...(yasno ? { yasno } : {}), ...(dtek ? { dtek } : {}) });
const off = (a, b) => ({ start: a, end: b, type: 'off' });

test('effectiveDays: YASNO со слотами; аварийные с пустым YASNO → ДТЭК; ожидание без ДТЭК → YASNO', () => {
    const days = {
        '2026-10-10': day({ status: 'ScheduleApplies', slots: [off(480, 600)] }, { status: 'ScheduleApplies', slots: [off(0, 60)] }),
        '2026-10-11': day({ status: 'EmergencyShutdowns', slots: [] }, { status: 'ScheduleApplies', slots: [off(1080, 1290)] }),
        '2026-10-12': day({ status: 'WaitingForSchedule', slots: [] }, null),
    };
    const eff = SP.effectiveDays(days, ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13']);
    assert.deepEqual(eff.map((e) => [e.source, e.emergency, e.slots.length]), [
        ['yasno', false, 1], ['dtek', true, 1], ['yasno', false, 0], [null, false, 0],
    ]);
});

test('хеш стабилен и меняется при смене слотов/статуса аварийных', () => {
    const a = { '2026-10-10': day({ status: 'ScheduleApplies', slots: [off(480, 600)] }) };
    const b = { '2026-10-10': day({ status: 'ScheduleApplies', slots: [off(480, 660)] }) };
    const c = { '2026-10-10': day({ status: 'EmergencyShutdowns', slots: [] }, { status: 'ScheduleApplies', slots: [off(480, 600)] }) };
    const h = (d) => SP.effectiveHash(SP.effectiveDays(d, ['2026-10-10', '2026-10-11']));
    assert.equal(h(a), h(JSON.parse(JSON.stringify(a))));
    assert.notEqual(h(a), h(b));
    assert.notEqual(h(a), h(c));   // те же слоты, но теперь «аварийные» и источник ДТЭК
});

test('сервис: первый раз — только запоминает; изменение — пуш; повтор — нет; дебаунс 5 мин', async () => {
    let t = new Date('2026-10-10T12:00:00Z');
    const clock = () => t;
    let days = { '2026-10-10': day({ status: 'ScheduleApplies', slots: [off(480, 600)] }) };
    const sent = [];
    const svc = SP.createSchedulePushService({
        scheduleService: { query: async () => ({ days }) },
        stateRepo: SP.createMemoryPushStateRepo(clock),
        sendPush: async (p) => { sent.push(p); return { sent: 1, failed: 0 }; },
        group: '49.1', debounceMinutes: 5, now: clock, log: { log() {} },
    });
    assert.equal((await svc.check()).reason, 'initialized');
    assert.equal((await svc.check()).reason, 'unchanged');
    days = { '2026-10-10': day({ status: 'ScheduleApplies', slots: [off(480, 600), off(1080, 1290)] }) };
    const r = await svc.check();
    assert.equal(r.pushed, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].date, '2026-10-10');
    assert.equal(sent[0].group, '49.1');
    days = { '2026-10-10': day({ status: 'EmergencyShutdowns', slots: [] }) };
    t = new Date('2026-10-10T12:02:00Z');
    assert.equal((await svc.check()).reason, 'debounced');
    t = new Date('2026-10-10T12:06:00Z');
    assert.equal((await svc.check()).pushed, true);
    assert.equal(sent.length, 2);
});
