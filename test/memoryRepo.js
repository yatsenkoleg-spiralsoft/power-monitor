/** In-memory реализация интерфейса scheduleRepo (та же семантика, что у MySQL-версии) — для тестов. */
function createMemoryRepo() {
    const rows = [];          // { date, group, source, status, slots, offMinutes, maybeMinutes, hash, sourceUpdatedAt, firstSeenAt, lastSeenAt, origin }
    const fetchState = {};
    let clock = () => new Date();
    const key = (r) => `${r.date}|${r.group}|${r.source}`;
    return {
        rows, fetchState,
        setClock(fn) { clock = fn; },
        async getLatestHashes(dates) {
            const m = new Map(), best = new Map();
            rows.filter((r) => dates.includes(r.date)).forEach((r) => {
                const b = best.get(key(r));
                if (!b || new Date(r.lastSeenAt) > new Date(b.lastSeenAt)) best.set(key(r), r);
            });
            best.forEach((r, k) => m.set(k, r.hash));
            return m;
        },
        async upsertVersions(list) {
            list.forEach((r) => {
                const seen = new Date(r.seenAt).toISOString();
                const ex = rows.find((x) => key(x) === key(r) && x.hash === r.hash);
                if (ex) {
                    if (seen > ex.lastSeenAt) ex.lastSeenAt = seen;
                    if (seen < ex.firstSeenAt) ex.firstSeenAt = seen;
                } else {
                    rows.push({ date: r.date, group: r.group, source: r.source, status: r.status, slots: r.slots,
                        offMinutes: r.offMinutes, maybeMinutes: r.maybeMinutes, hash: r.hash,
                        sourceUpdatedAt: r.sourceUpdatedAt ? new Date(r.sourceUpdatedAt).toISOString() : null,
                        firstSeenAt: seen, lastSeenAt: seen, origin: r.origin });
                }
            });
        },
        async getRange(group, start, end, source) {
            return rows.filter((r) => r.group === group && r.date >= start && r.date <= end && (!source || r.source === source))
                .sort((a, b) => (a.date + a.source + a.firstSeenAt < b.date + b.source + b.firstSeenAt ? -1 : 1));
        },
        async claimFetchSlot(name, minutes) {
            const s = fetchState[name] || (fetchState[name] = {});
            const t = clock().getTime();
            if (s.lastAttemptAt && t - s.lastAttemptAt < minutes * 60000) return false;
            s.lastAttemptAt = t; return true;
        },
        async setFetchState(name, st) { fetchState[name] = { ...(fetchState[name] || {}), ...st }; },
        async getFetchStates() { return fetchState; },
    };
}
module.exports = { createMemoryRepo };
