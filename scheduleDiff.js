/**
 * Человекочитаемый diff эффективного графика (effectiveDays из schedulePush.js) — для текста пуша.
 * Пример: «Сегодня: было 18:00–22:00 → стало 17:00–20:30», «Завтра: появился график — 06:00–08:00».
 */
const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const iv = (s) => `${fmt(s[0])}–${fmt(s[1])}${s[2] === 'maybe' ? ' (возможно)' : ''}`;
const overlaps = (a, b) => a[2] === b[2] && a[0] < b[1] && b[0] < a[1];
const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const isWaiting = (st) => /Waiting|NoSchedule/i.test(st || '');

/** Изменения интервалов одного дня → [{kind:'changed'|'added'|'removed', from?, to?}] */
function diffSlots(prev, next) {
    const out = [];
    const usedN = new Set();
    const usedP = new Set();
    prev.forEach((p, i) => { next.forEach((n, j) => { if (same(p, n)) { usedP.add(i); usedN.add(j); } }); });
    prev.forEach((p, i) => {
        if (usedP.has(i)) return;
        const ov = next.map((n, j) => [n, j]).filter(([n, j]) => !usedN.has(j) && overlaps(p, n));
        if (ov.length) {
            const back = prev.filter((q, k) => !usedP.has(k) && ov.some(([n]) => overlaps(q, n)));
            ov.forEach(([, j]) => usedN.add(j));
            prev.forEach((q, k) => { if (back.includes(q)) usedP.add(k); });
            out.push({ kind: 'changed', from: back, to: ov.map(([n]) => n) });
        }
    });
    prev.forEach((p, i) => { if (!usedP.has(i)) out.push({ kind: 'removed', from: [p] }); });
    next.forEach((n, j) => { if (!usedN.has(j)) out.push({ kind: 'added', to: [n] }); });
    const key = (c) => (c.from || c.to)[0][0];
    return out.sort((a, b) => key(a) - key(b));
}

/**
 * @param prevEff  предыдущий снимок (массив {date, status, emergency, slots}) или null
 * @param nextEff  новый снимок
 * @param labels   { 'YYYY-MM-DD': 'Сегодня', ... }
 * @returns {{ text: string, days: Array<{date, label, appeared?, emergency?, changes}> }}
 */
function describeScheduleChange(prevEff, nextEff, labels = {}) {
    const prevBy = {};
    (prevEff || []).forEach((d) => { prevBy[d.date] = d; });
    const lines = [];
    const days = [];
    for (const d of nextEff || []) {
        const label = labels[d.date] || d.date;
        const p = prevBy[d.date];
        const hadGraph = p && (p.slots.length || (p.status && !isWaiting(p.status)));
        const hasGraph = d.slots.length || (d.status && !isWaiting(d.status));
        const day = { date: d.date, label, changes: [] };
        const parts = [];
        if (p && !!p.emergency !== !!d.emergency) {
            day.emergency = !!d.emergency;
            parts.push(d.emergency ? 'аварийные отключения' : 'аварийные отключения отменены');
        }
        if (!hadGraph && hasGraph) {
            day.appeared = true;
            parts.push(d.slots.length ? `появился график — ${d.slots.map(iv).join(', ')}` : 'появился график — отключений нет');
        } else if (hadGraph && !hasGraph) {
            parts.push('график снят (ожидание)');
        } else if (p) {
            day.changes = diffSlots(p.slots, d.slots);
            for (const c of day.changes) {
                if (c.kind === 'changed') parts.push(`было ${c.from.map(iv).join(', ')} → стало ${c.to.map(iv).join(', ')}`);
                else if (c.kind === 'added') parts.push(`добавлено ${iv(c.to[0])}`);
                else parts.push(`отменено ${iv(c.from[0])}`);
            }
            if (!d.slots.length && p.slots.length) parts.push('отключений нет');
        }
        if (parts.length) {
            lines.push(`${label}: ${parts.join('; ')}`);
            day.changes = day.changes.map((c) => ({ kind: c.kind, from: (c.from || []).map(iv), to: (c.to || []).map(iv) }));
            days.push(day);
        }
    }
    return { text: lines.join('\n'), days };
}

module.exports = { describeScheduleChange, diffSlots, fmt };
