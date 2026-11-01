const assert = require('assert');
const { computeTransitions, deriveState } = require('./alertPush');
const S = (alert, bal, balSrc) => ({ ok: true, alert, bal, balSrc, rad: false, radSince: null });
const SR = (alert, bal, balSrc, rad, radSince) => ({ ok: true, alert, bal, balSrc, rad, radSince });
let st = computeTransitions(null, S('none','none')); assert.strictEqual(st.events.length, 0);
let p = st.next;
const step = (c) => { const r = computeTransitions(p, c, 2); p = r.next; return r.events.map(e => e.type + (e.data.confirmed ? ':' + e.data.confirmed : '') + (e.data.upgrade ? '+up' : '') + (e.data.change ? '+ch' : '')); };
assert.deepStrictEqual(step(S('drone','none')), ['alert_drone']);
assert.deepStrictEqual(step(S('missile','q','neptun')), ['ballistic_start:0', 'alert_missile+ch']);
assert.deepStrictEqual(step(S('missile','c','kd')), ['ballistic_start:1+up']);
assert.deepStrictEqual(step(S('missile','q','pszsu')), []);
assert.deepStrictEqual(step(S('missile','none')), []);
assert.deepStrictEqual(step(S('missile','none')), ['ballistic_end:1']);
assert.deepStrictEqual(step(S('none','none')), []);
assert.deepStrictEqual(step(S('drone','none')), ['alert_drone+ch']); // ракеты сняли, дроны остались
assert.deepStrictEqual(step(S('none','none')), []);
assert.deepStrictEqual(step(S('none','none')), ['alert_end']);

// deriveState: AIR/air_raid → drone/missile, NUCLEAR не мапится
assert.deepStrictEqual(deriveState({ ok: true, alerts: [{ type: 'AIR' }], uaRed: false, ballistic: false }), { ok: true, alert: 'drone', bal: 'none', balSrc: null, rad: false, radSince: null });
assert.deepStrictEqual(deriveState({ ok: true, alerts: [{ type: 'air_raid' }], uaRed: true, ballistic: false }), { ok: true, alert: 'missile', bal: 'none', balSrc: null, rad: false, radSince: null });
assert.deepStrictEqual(deriveState({ ok: true, alerts: [{ type: 'NUCLEAR' }], uaRed: false, ballistic: false }), { ok: true, alert: 'none', bal: 'none', balSrc: null, rad: false, radSince: null });
assert.deepStrictEqual(deriveState({ ok: true, alerts: [{ type: 'CHEMICAL' }], uaRed: false, ballistic: false }), { ok: true, alert: 'none', bal: 'none', balSrc: null, rad: false, radSince: null });
assert.deepStrictEqual(deriveState({ ok: true, alerts: [{ type: 'URBAN_FIGHTS' }], uaRed: false, ballistic: false }), { ok: true, alert: 'none', bal: 'none', balSrc: null, rad: false, radSince: null });
assert.deepStrictEqual(deriveState({ ok: true, alerts: [{ type: 'AIR' }, { type: 'NUCLEAR' }], uaRed: true, ballistic: false }), { ok: true, alert: 'missile', bal: 'none', balSrc: null, rad: false, radSince: null });

assert.deepStrictEqual(deriveState({ ok: true, alerts: [{}], uaRed: true, ballistic: true, ballisticSrc: 'ain' }).bal, 'c');
assert.strictEqual(deriveState({ ok: false }).ok, false);
// v59: ballisticQ
const dq = (j) => deriveState({ ok: true, alerts: [{ type: 'AIR' }], uaRed: true, ...j });
assert.deepStrictEqual(dq({ ballistic: false, ballisticSrc: 'pszsu', ballisticQ: true, ballisticQSrc: 'pszsu_kyiv' }), { ok: true, alert: 'missile', bal: 'q', balSrc: 'pszsu_kyiv', rad: false, radSince: null });
assert.strictEqual(dq({ ballistic: false, ballisticSrc: 'neptun' }).bal, 'none');            // старый шумный признак без ballisticQ — игнор
assert.strictEqual(dq({ ballistic: false, ballisticSrc: 'pszsu', ballisticQ: false }).bal, 'none');
assert.strictEqual(dq({ ballistic: true, ballisticSrc: 'kd', ballisticQ: true }).bal, 'c');
assert.deepStrictEqual(deriveState({ ok: true, alerts: [], uaRed: false, ballistic: false, ballisticQ: true, ballisticQSrc: 'pszsu_kyiv' }).alert, 'missile');

// радиационная опасность: rad = NUCLEAR в alerts[] + ain.kyiv[] має м. Київ + alertType nuclear
assert.strictEqual(deriveState({ ok: true, alerts: [{ type: 'NUCLEAR' }], ain: { kyiv: [{ title: 'м. Київ', alertType: 'nuclear', createdAt: '2026-11-01T12:00:00Z' }] } }).rad, true);
assert.strictEqual(deriveState({ ok: true, alerts: [{ type: 'NUCLEAR' }], ain: { kyiv: [{ title: 'м. Київ', alertType: 'air_raid' }] } }).rad, false);
assert.strictEqual(deriveState({ ok: true, alerts: [{ type: 'AIR' }], ain: { kyiv: [{ title: 'м. Київ', alertType: 'nuclear' }] } }).rad, false);
assert.strictEqual(deriveState({ ok: true, alerts: [{ type: 'NUCLEAR' }], ain: { kyiv: [{ title: 'Київська обл.', alertType: 'nuclear' }] } }).rad, false);
assert.strictEqual(deriveState({ ok: true, alerts: [{ type: 'NUCLEAR' }], ain: { kyiv: [] } }).rad, false);
assert.strictEqual(deriveState({ ok: true, alerts: [{ type: 'NUCLEAR' }] }).rad, false);

// радиационная: 2-poll start, 3-poll end
let rp = computeTransitions(null, SR('none','none', null, false, null), 2, 0, 0, 2, 3).next;
const radStep = (c, t) => { const r = computeTransitions(rp, c, 2, t, 0, 2, 3); rp = r.next; return r.events.map(e => e.type + (e.data.since ? ':since' : '')); };
assert.deepStrictEqual(radStep(SR('none','none',null,true,'2026-11-01T12:00:00Z'), 1), []);  // перший раз rad=true: pending, без пуша
assert.deepStrictEqual(radStep(SR('none','none',null,true,'2026-11-01T12:00:00Z'), 2), ['radiation_start:since']); // другий раз: пуш
assert.deepStrictEqual(radStep(SR('none','none',null,false,null), 3), []);   // перший чистий опрос
assert.deepStrictEqual(radStep(SR('none','none',null,false,null), 4), []);   // другий
assert.deepStrictEqual(radStep(SR('none','none',null,false,null), 5), ['radiation_end']);   // третій: radiation_end

// радиационная: silent first record (initialized=true, rad=pending without push)
let init = computeTransitions(null, SR('none','none',null,true,'2026-11-01T12:00:00Z'), 2, 0, 0, 2, 3);
assert.strictEqual(init.initialized, true);
assert.strictEqual(init.next.rad, 'pending');
assert.strictEqual(init.events.length, 0);

// удержание «?» 10 мин
const M = 60000; let q = computeTransitions(null, S('drone', 'none'), 2, 0).next;
const qs = (c, t) => { const r = computeTransitions(q, c, 2, t * M, 10 * M); q = r.next; return r.events.map(e => e.type + (e.data.confirmed ? ':' + e.data.confirmed : '')); };
assert.deepStrictEqual(qs(S('missile', 'q', 'neptun_burst'), 1), ['ballistic_start:0', 'alert_missile']);
assert.deepStrictEqual(qs(S('missile', 'none'), 2), []);
assert.deepStrictEqual(qs(S('missile', 'none'), 3), []);   // 2 чистих опросов, але ще тримаємо
assert.deepStrictEqual(qs(S('missile', 'q', 'pszsu_kyiv'), 5), []);   // повтор в удержании — без нового пуша
assert.deepStrictEqual(qs(S('missile', 'none'), 10), []);
assert.deepStrictEqual(qs(S('missile', 'none'), 14), []);
assert.deepStrictEqual(qs(S('missile', 'none'), 15), ['ballistic_end:0']);   // 10 мин после последнего «?»
assert.strictEqual(q.balAt, undefined);
// подтверждённая — конец как раньше, без удержания
let c = computeTransitions(null, S('missile', 'none'), 2, 0).next;
c = computeTransitions(c, S('missile', 'c', 'kd'), 2, M).next; c = computeTransitions(c, S('missile', 'none'), 2, 2 * M).next;
assert.deepStrictEqual(computeTransitions(c, S('missile', 'none'), 2, 3 * M).events.map(e => e.type), ['ballistic_end']);
console.log('alertPush tests OK');

