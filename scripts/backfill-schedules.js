#!/usr/bin/env node
/**
 * Импорт прошлых графиков ДТЭК из git-истории outage-data-ua в таблицу outage_schedules.
 *
 *   node scripts/backfill-schedules.js --days 60                 # прямо в MySQL (нужны MYSQL_* переменные)
 *   node scripts/backfill-schedules.js --days 60 --sql out.sql   # без доступа к БД: сгенерировать SQL-файл
 *   node scripts/backfill-schedules.js --from 2026-08-01 --to 2026-09-30 --groups 49.1
 *   GITHUB_TOKEN=... node scripts/backfill-schedules.js --days 240   # с токеном лимит 5000/час
 *
 * Флаги: --days N (по умолчанию 60, до вчера включительно) | --from/--to YYYY-MM-DD
 *        --groups '*'|49.1,45.1 (по умолчанию все очереди) | --sql FILE | --dry-run | --wait (ждать сброса лимита)
 * Повторный запуск безопасен: одинаковые версии не дублируются (UNIQUE по хэшу).
 */
const fs = require('fs');
const path = require('path');
const { createScheduleService, kyivDateKey, addDays, contentHash } = require('../schedules');
const { createGithubHistory, RateLimitError, HISTORY_START } = require('../githubHistory');

function args(argv) {
    const a = { days: 60, groups: '*', sql: null, dryRun: false, wait: false, from: null, to: null };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i], v = argv[i + 1];
        if (k === '--days') { a.days = +v; i++; } else if (k === '--groups') { a.groups = v; i++; }
        else if (k === '--sql') { a.sql = v; i++; } else if (k === '--from') { a.from = v; i++; }
        else if (k === '--to') { a.to = v; i++; } else if (k === '--dry-run') a.dryRun = true;
        else if (k === '--wait') a.wait = true;
        else if (k === '-h' || k === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
    }
    return a;
}

const esc = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
const dt = (d) => (d ? new Date(d).toISOString().slice(0, 19).replace('T', ' ') : null);

/** «Хранилище», которое пишет SQL в файл (для импорта через mysql-клиент / Cloud SQL Studio) */
function createSqlFileRepo(file) {
    const out = fs.createWriteStream(file);
    out.write('-- backfill outage_schedules from outage-data-ua git history\nSET NAMES utf8mb4;\n');
    return {
        out,
        async getLatestHashes() { return new Map(); },
        async upsertVersions(rows) {
            rows.forEach((r) => {
                out.write(`INSERT INTO outage_schedules (schedule_date, group_code, source, status, slots, off_minutes, maybe_minutes, content_hash, source_updated_at, first_seen_at, last_seen_at, origin) VALUES (${
                    [r.date, r.group, r.source, r.status, JSON.stringify(r.slots), r.offMinutes, r.maybeMinutes, r.hash || contentHash(r.status, r.slots),
                        dt(r.sourceUpdatedAt), dt(r.seenAt), dt(r.seenAt), r.origin].map(esc).join(', ')
                }) ON DUPLICATE KEY UPDATE last_seen_at = GREATEST(last_seen_at, VALUES(last_seen_at)), first_seen_at = LEAST(first_seen_at, VALUES(first_seen_at));\n`);
            });
        },
    };
}

async function main() {
    const a = args(process.argv);
    const yesterday = addDays(kyivDateKey(new Date()), -1);
    const to = a.to || yesterday;
    let from = a.from || addDays(to, -(a.days - 1));
    if (from < HISTORY_START) from = HISTORY_START;
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    console.log(`Дней: ${days.length} (${from} — ${to}), очереди: ${a.groups}, токен GitHub: ${process.env.GITHUB_TOKEN ? 'да' : 'нет (60 запросов/час)'}`);

    let repo, closeDb = async () => {};
    if (a.sql) repo = createSqlFileRepo(a.sql);
    else if (a.dryRun) repo = { async getLatestHashes() { return new Map(); }, async upsertVersions() {} };
    else {
        const db = require('../db');
        const { createMysqlScheduleRepo } = require('../scheduleRepo');
        repo = createMysqlScheduleRepo(db.getPool);
        closeDb = () => db.closePool();
    }
    const service = createScheduleService({ repo });
    const gh = createGithubHistory();
    let ok = 0, versions = 0;
    for (let i = 0; i < days.length; i++) {
        const day = days[i];
        try {
            const res = await gh.fetchDay(day, a.groups);
            if (res.items.length) {
                const st = await service.store(res.items, { origin: 'backfill', seenAt: res.commitDate });
                ok++; versions += st.inserted;
                const g = res.items.find((x) => x.group === '49.1') || res.items[0];
                console.log(`${day}  @${res.sha.slice(0, 7)} ${res.commitDate.toISOString()}  очередей: ${res.items.length}  ${g.group}: откл. ${g.slots.filter((s) => s.type === 'off').map((s) => `${s.start / 60}–${s.end / 60}`).join(', ') || 'нет'}`);
            } else console.log(`${day}  — ${res.note}`);
        } catch (e) {
            if (e instanceof RateLimitError) {
                if (a.wait) {
                    const ms = Math.max(0, e.resetAt - Date.now()) + 5000;
                    console.log(`Лимит GitHub исчерпан, жду ${Math.ceil(ms / 60000)} мин...`);
                    await new Promise((r) => setTimeout(r, ms)); i--; continue;
                }
                console.log(`\n${e.message}. Продолжить позже: node scripts/backfill-schedules.js --from ${day} --to ${to}${a.sql ? ' --sql ' + path.basename(a.sql, '.sql') + '-2.sql' : ''}  (или задайте GITHUB_TOKEN / --wait)`);
                break;
            }
            console.log(`${day}  ошибка: ${e.message}`);
        }
    }
    console.log(`\nГотово: дней с данными ${ok}/${days.length}, записей (дата×очередь) ${versions}. Остаток лимита API: ${gh.rate.remaining ?? '?'}`);
    if (repo.out) await new Promise((r) => repo.out.end(r));
    await closeDb();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { createSqlFileRepo };
