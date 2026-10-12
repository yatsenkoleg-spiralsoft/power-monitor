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
console.log('scheduleDiff tests OK');
