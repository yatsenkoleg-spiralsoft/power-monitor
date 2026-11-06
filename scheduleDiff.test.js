const assert = require('assert');
const { describeScheduleChange } = require('./scheduleDiff');
const h = (s) => { const [a, b] = s.split(':').map(Number); return a * 60 + b; };
const S = (a, b, t = 'off') => [h(a), h(b), t];
const L = { '2026-10-13': 'Сегодня', '2026-10-14': 'Завтра' };
const day = (date, slots, status = 'ScheduleApplies', emergency = false) => ({ date, source: 'yasno', status, emergency, slots });

// изменение интервала
let r = describeScheduleChange([day('2026-10-13', [S('18:00', '22:00')])], [day('2026-10-13', [S('17:00', '20:30')])], L);
assert.strictEqual(r.text, 'Сегодня: было 18:00–22:00 → стало 17:00–20:30');
// добавлено + отменено
r = describeScheduleChange([day('2026-10-13', [S('10:00', '12:00')])], [day('2026-10-13', [S('06:00', '08:00')])], L);
assert.strictEqual(r.text, 'Сегодня: добавлено 06:00–08:00; отменено 10:00–12:00');
// завтра появился
r = describeScheduleChange([day('2026-10-14', [], 'WaitingForSchedule')], [day('2026-10-14', [S('06:00', '08:00'), S('17:00', '20:30')])], L);
assert.strictEqual(r.text, 'Завтра: появился график — 06:00–08:00, 17:00–20:30');
// завтра раньше вообще не было в снимке
r = describeScheduleChange([day('2026-10-13', [S('18:00', '22:00')])],
    [day('2026-10-13', [S('18:00', '22:00')]), day('2026-10-14', [], 'ScheduleApplies')], L);
assert.strictEqual(r.text, 'Завтра: появился график — отключений нет');
// все отменены
r = describeScheduleChange([day('2026-10-13', [S('18:00', '22:00')])], [day('2026-10-13', [])], L);
assert.strictEqual(r.text, 'Сегодня: отменено 18:00–22:00; отключений нет');
// слияние двух в один
r = describeScheduleChange([day('2026-10-13', [S('08:00', '10:00'), S('11:00', '13:00')])], [day('2026-10-13', [S('08:00', '13:00')])], L);
assert.strictEqual(r.text, 'Сегодня: было 08:00–10:00, 11:00–13:00 → стало 08:00–13:00');
// без изменений
r = describeScheduleChange([day('2026-10-13', [S('18:00', '22:00')])], [day('2026-10-13', [S('18:00', '22:00')])], L);
assert.strictEqual(r.text, '');
// аварийные
r = describeScheduleChange([day('2026-10-13', [])], [day('2026-10-13', [], 'EmergencyShutdowns', true)], L);
assert.ok(r.text.startsWith('Сегодня: аварийные отключения'), r.text);
// две строки
r = describeScheduleChange([day('2026-10-13', [S('18:00', '22:00')]), day('2026-10-14', [], 'WaitingForSchedule')],
    [day('2026-10-13', [S('17:00', '20:30')]), day('2026-10-14', [S('06:00', '08:00')])], L);
assert.strictEqual(r.text, 'Сегодня: было 18:00–22:00 → стало 17:00–20:30\nЗавтра: появился график — 06:00–08:00');
assert.strictEqual(r.days.length, 2);

// Emergency mode with WaitingForSchedule (no published schedule) should be omitted entirely
r = describeScheduleChange(
    [day('2026-10-14', [], 'WaitingForSchedule', false)],
    [day('2026-10-14', [], 'EmergencyShutdowns', true)], L);
assert.ok(!r.text.includes('появился график'), 'Emergency WaitingForSchedule should not claim schedule appeared: ' + r.text);
assert.ok(!r.text.includes('Завтра'), 'Unpublished emergency tomorrow should be omitted: ' + r.text);

// Emergency mode from null/missing (no published schedule) should also be omitted
r = describeScheduleChange(
    [],
    [day('2026-10-14', [], 'EmergencyShutdowns', true)], L);
assert.ok(!r.text.includes('появился график'), 'New emergency WaitingForSchedule should not claim schedule appeared: ' + r.text);
assert.ok(!r.text.includes('Завтра'), 'Unpublished emergency tomorrow should be omitted: ' + r.text);

// Published emergency schedule WITH slots should claim schedule appeared
r = describeScheduleChange(
    [day('2026-10-14', [], 'WaitingForSchedule', false)],
    [day('2026-10-14', [S('10:00', '12:00')], 'EmergencyShutdowns', true)], L);
assert.ok(r.text.includes('появился график'), 'Emergency with published slots should claim schedule appeared: ' + r.text);
assert.ok(r.text.includes('аварийные отключения'), 'Should mention emergency mode: ' + r.text);
assert.ok(r.text.includes('10:00'), 'Should show slots: ' + r.text);

// Transition from WaitingForSchedule to ScheduleApplies with empty slots (explicit no outages)
r = describeScheduleChange(
    [day('2026-10-14', [], 'WaitingForSchedule', false)],
    [day('2026-10-14', [], 'ScheduleApplies', false)], L);
assert.ok(r.text.includes('появился график — отключений нет'), 'Published empty schedule should show: ' + r.text);

console.log('scheduleDiff tests OK');
