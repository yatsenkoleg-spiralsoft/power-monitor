const assert = require('assert');
const { computeTransitions, deriveState } = require('./alertPush');
const S = (alert, bal, balSrc) => ({ ok: true, alert, bal, balSrc });
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
assert.deepStrictEqual(deriveState({ ok: true, alerts: [{}], uaRed: false, ballistic: false }), { ok: true, alert: 'drone', bal: 'none', balSrc: null });
assert.deepStrictEqual(deriveState({ ok: true, alerts: [{}], uaRed: true, ballistic: true, ballisticSrc: 'ain' }).bal, 'c');
assert.strictEqual(deriveState({ ok: false }).ok, false);
// v59: ballisticQ
const dq = (j) => deriveState({ ok: true, alerts: [{}], uaRed: true, ...j });
assert.deepStrictEqual(dq({ ballistic: false, ballisticSrc: 'pszsu', ballisticQ: true, ballisticQSrc: 'pszsu_kyiv' }), { ok: true, alert: 'missile', bal: 'q', balSrc: 'pszsu_kyiv' });
assert.strictEqual(dq({ ballistic: false, ballisticSrc: 'neptun' }).bal, 'none');            // старый шумный признак без ballisticQ — игнор
assert.strictEqual(dq({ ballistic: false, ballisticSrc: 'pszsu', ballisticQ: false }).bal, 'none');
assert.strictEqual(dq({ ballistic: true, ballisticSrc: 'kd', ballisticQ: true }).bal, 'c');
assert.deepStrictEqual(deriveState({ ok: true, alerts: [], uaRed: false, ballistic: false, ballisticQ: true, ballisticQSrc: 'pszsu_kyiv' }).alert, 'missile');
// удержание «?» 10 мин
const M = 60000; let q = computeTransitions(null, S('drone', 'none'), 2, 0).next;
const qs = (c, t) => { const r = computeTransitions(q, c, 2, t * M, 10 * M); q = r.next; return r.events.map(e => e.type + (e.data.confirmed ? ':' + e.data.confirmed : '')); };
assert.deepStrictEqual(qs(S('missile', 'q', 'neptun_burst'), 1), ['ballistic_start:0', 'alert_missile']);
assert.deepStrictEqual(qs(S('missile', 'none'), 2), []);
assert.deepStrictEqual(qs(S('missile', 'none'), 3), []);   // 2 чистых опроса, но ещё держим
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
