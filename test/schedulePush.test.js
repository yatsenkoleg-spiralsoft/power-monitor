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
        group: '58.1', debounceMinutes: 5, now: clock, log: { log() {} },
    });
    assert.equal((await svc.check()).reason, 'initialized');
    assert.equal((await svc.check()).reason, 'unchanged');
    days = { '2026-10-10': day({ status: 'ScheduleApplies', slots: [off(480, 600), off(1080, 1290)] }) };
    const r = await svc.check();
    assert.equal(r.pushed, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].date, '2026-10-10');
    assert.equal(sent[0].group, '58.1');
    days = { '2026-10-10': day({ status: 'EmergencyShutdowns', slots: [] }) };
    t = new Date('2026-10-10T12:02:00Z');
    assert.equal((await svc.check()).reason, 'debounced');
    t = new Date('2026-10-10T12:06:00Z');
    assert.equal((await svc.check()).pushed, true);
    assert.equal(sent.length, 2);
});

test('сервис: хеш изменился, но нет содержательных изменений — пуш не отправляется', async () => {
    let t = new Date('2026-10-10T12:00:00Z');
    const clock = () => t;
    let days = { '2026-10-10': day({ status: 'ScheduleApplies', slots: [off(480, 600)] }) };
    const sent = [];
    const repo = SP.createMemoryPushStateRepo(clock);
    const svc = SP.createSchedulePushService({
        scheduleService: { query: async () => ({ days }) },
        stateRepo: repo,
        sendPush: async (p) => { sent.push(p); return { sent: 1, failed: 0 }; },
        group: '58.1', debounceMinutes: 5, now: clock, log: { log() {} },
    });
    assert.equal((await svc.check()).reason, 'initialized');
    days = { '2026-10-10': day({ status: 'ScheduleApplies', slots: [off(480, 600)] }), '2026-10-11': day({ status: 'WaitingForSchedule', slots: [] }) };
    t = new Date('2026-10-10T12:06:00Z');
    const r = await svc.check();
    assert.equal(r.pushed, false);
    assert.equal(r.reason, 'empty_diff');
    assert.equal(sent.length, 0);
});

test('сервис: отсутствует snapshot, хеш изменился — пуш не отправляется, snapshot сохраняется', async () => {
    let t = new Date('2026-10-10T12:00:00Z');
    const clock = () => t;
    let days = { '2026-10-10': day({ status: 'ScheduleApplies', slots: [off(480, 600)] }) };
    const sent = [];
    const repo = SP.createMemoryPushStateRepo(clock);
    const svc = SP.createSchedulePushService({
        scheduleService: { query: async () => ({ days }) },
        stateRepo: repo,
        sendPush: async (p) => { sent.push(p); return { sent: 1, failed: 0 }; },
        group: '58.1', debounceMinutes: 5, now: clock, log: { log() {} },
    });
    assert.equal((await svc.check()).reason, 'initialized');
    delete repo.snaps['schedule:58.1'];
    days = { '2026-10-10': day({ status: 'ScheduleApplies', slots: [off(480, 600), off(1080, 1290)] }) };
    t = new Date('2026-10-10T12:06:00Z');
    const r = await svc.check();
    assert.equal(r.pushed, false);
    assert.equal(r.reason, 'empty_diff');
    assert.equal(sent.length, 0);
    assert.ok(repo.snaps['schedule:58.1']);
    days = { '2026-10-10': day({ status: 'ScheduleApplies', slots: [off(480, 600)] }) };
    t = new Date('2026-10-10T12:12:00Z');
    const r2 = await svc.check();
    assert.equal(r2.pushed, true);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes('отменено'));
});

test('сервис: переход в аварийный режим без слотов на завтра не должен говорить о появлении графика', async () => {
    let t = new Date('2026-11-06T09:00:00Z');
    const clock = () => t;
    let days = {
        '2026-11-06': day({ status: 'ScheduleApplies', slots: [off(630, 1020), off(1230, 1440)] }),
        '2026-11-07': day({ status: 'WaitingForSchedule', slots: [] }),
    };
    const sent = [];
    const repo = SP.createMemoryPushStateRepo(clock);
    const svc = SP.createSchedulePushService({
        scheduleService: { query: async () => ({ days }) },
        stateRepo: repo,
        sendPush: async (p) => { sent.push(p); return { sent: 1, failed: 0 }; },
        group: '58.1', debounceMinutes: 5, now: clock, log: { log() {} },
    });
    assert.equal((await svc.check()).reason, 'initialized');
    days = {
        '2026-11-06': day({ status: 'EmergencyShutdowns', slots: [off(630, 1080), off(1200, 1440)] }),
        '2026-11-07': day({ status: 'EmergencyShutdowns', slots: [] }),
    };
    t = new Date('2026-11-06T09:06:00Z');
    const r = await svc.check();
    assert.equal(r.pushed, true, 'Should push for today changes');
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes('Сегодня'), 'Should have today changes');
    assert.ok(sent[0].text.includes('аварийные отключения'), 'Should mention emergency');
    assert.ok(!sent[0].text.includes('Завтра'), 'Should NOT include tomorrow with unpublished schedule');
    assert.ok(!sent[0].text.includes('появился график'), 'Should NOT claim schedule appeared for unpublished tomorrow');
});

test('сервис: реальное изменение сегодня + переход завтра в EmergencyShutdowns без графика — только сегодня в пуше', async () => {
    let t = new Date('2026-11-06T09:00:00Z');
    const clock = () => t;
    let days = {
        '2026-11-06': day({ status: 'ScheduleApplies', slots: [off(630, 1020), off(1230, 1440)] }),
        '2026-11-07': day({ status: 'WaitingForSchedule', slots: [] }),
    };
    const sent = [];
    const repo = SP.createMemoryPushStateRepo(clock);
    const svc = SP.createSchedulePushService({
        scheduleService: { query: async () => ({ days }) },
        stateRepo: repo,
        sendPush: async (p) => { sent.push(p); return { sent: 1, failed: 0 }; },
        group: '58.1', debounceMinutes: 5, now: clock, log: { log() {} },
    });
    assert.equal((await svc.check()).reason, 'initialized');
    days = {
        '2026-11-06': day({ status: 'EmergencyShutdowns', slots: [off(630, 1080), off(1200, 1440)] }),
        '2026-11-07': day({ status: 'EmergencyShutdowns', slots: [] }),
    };
    t = new Date('2026-11-06T09:06:00Z');
    const r = await svc.check();
    assert.equal(r.pushed, true);
    assert.equal(sent.length, 1);
    const lines = sent[0].text.split('\n');
    assert.equal(lines.filter((l) => l.startsWith('Сегодня')).length, 1, 'Should have exactly one today line');
    assert.equal(lines.filter((l) => l.startsWith('Завтра')).length, 0, 'Should have NO tomorrow line');
});

test('сервис: опубликованный график завтра с EmergencyShutdowns и слотами — должен упоминаться', async () => {
    let t = new Date('2026-11-06T09:00:00Z');
    const clock = () => t;
    let days = {
        '2026-11-06': day({ status: 'ScheduleApplies', slots: [off(630, 1020)] }),
        '2026-11-07': day({ status: 'WaitingForSchedule', slots: [] }),
    };
    const sent = [];
    const repo = SP.createMemoryPushStateRepo(clock);
    const svc = SP.createSchedulePushService({
        scheduleService: { query: async () => ({ days }) },
        stateRepo: repo,
        sendPush: async (p) => { sent.push(p); return { sent: 1, failed: 0 }; },
        group: '58.1', debounceMinutes: 5, now: clock, log: { log() {} },
    });
    assert.equal((await svc.check()).reason, 'initialized');
    days = {
        '2026-11-06': day({ status: 'ScheduleApplies', slots: [off(630, 1020)] }),
        '2026-11-07': day({ status: 'EmergencyShutdowns', slots: [off(600, 900)] }),
    };
    t = new Date('2026-11-06T09:06:00Z');
    const r = await svc.check();
    assert.equal(r.pushed, true);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes('Завтра'), 'Should mention tomorrow when it has published slots');
    assert.ok(sent[0].text.includes('аварийные отключения'), 'Should mention emergency');
    assert.ok(sent[0].text.includes('появился график'), 'Should claim schedule appeared with actual slots');
    assert.ok(sent[0].text.includes('10:00'), 'Should show slot times');
});
