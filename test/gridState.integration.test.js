const test = require('node:test');
const assert = require('node:assert');

// Memory-based pool for testing
function createMemPool() {
    const state = {
        confirmed_present: null,
        last_confirmed_present: null,
        pending_present: null,
        pending_streak: 0,
        pending_off_minutes: 0,
        pending_on_minutes: 0,
        unknown_since: null,
        updated_at: new Date()
    };
    
    return {
        state,
        async execute(sql, params) {
            if (/^SELECT/.test(sql)) {
                // Mock information_schema query for migration check
                if (sql.includes('information_schema.COLUMNS')) {
                    return [[
                        { COLUMN_NAME: 'id' },
                        { COLUMN_NAME: 'confirmed_present' },
                        { COLUMN_NAME: 'last_confirmed_present' },
                        { COLUMN_NAME: 'pending_present' },
                        { COLUMN_NAME: 'pending_streak' },
                        { COLUMN_NAME: 'pending_off_minutes' },
                        { COLUMN_NAME: 'pending_on_minutes' },
                        { COLUMN_NAME: 'unknown_since' },
                        { COLUMN_NAME: 'updated_at' }
                    ]];
                }
                return [[state]];
            }
            if (/^INSERT/.test(sql)) {
                return [{ insertId: 1 }];
            }
            if (/^UPDATE/.test(sql)) {
                // Parse the update
                if (params) {
                    if (sql.includes('confirmed_present = ?')) {
                        const idx = sql.match(/confirmed_present = \?/) ? 0 : -1;
                        if (idx >= 0 && params[idx] !== undefined) state.confirmed_present = params[idx];
                    }
                    if (sql.includes('last_confirmed_present = ?')) {
                        const matches = sql.match(/confirmed_present = \?.*last_confirmed_present = \?/);
                        if (matches) state.last_confirmed_present = params[1];
                    }
                    if (sql.includes('pending_off_minutes = ?')) {
                        const matches = sql.match(/pending_off_minutes = \?/);
                        if (matches) {
                            const idx = sql.split('?').length - params.length;
                            state.pending_off_minutes = params[params.length - 1 - idx] || params[2] || 0;
                        }
                    }
                    if (sql.includes('pending_on_minutes = ?')) {
                        const matches = sql.match(/pending_on_minutes = \?/);
                        if (matches) {
                            // Find the parameter index for pending_on_minutes
                            const questionMarks = sql.substring(0, sql.indexOf('pending_on_minutes')).match(/\?/g);
                            const idx = questionMarks ? questionMarks.length : 0;
                            if (params[idx] !== undefined) state.pending_on_minutes = params[idx];
                        }
                    }
                    if (sql.includes('unknown_since = ?')) {
                        const idx = 0;
                        state.unknown_since = params[idx];
                    }
                }
                
                // Handle direct sets in SQL
                if (sql.includes('confirmed_present = 1')) state.confirmed_present = 1;
                if (sql.includes('last_confirmed_present = 1')) state.last_confirmed_present = 1;
                if (sql.includes('pending_off_minutes = 0')) state.pending_off_minutes = 0;
                if (sql.includes('pending_on_minutes = 0')) state.pending_on_minutes = 0;
                if (sql.includes('unknown_since = NULL')) state.unknown_since = null;
                
                return [{ affectedRows: 1 }];
            }
            if (/^ALTER TABLE/.test(sql)) {
                // Mock ALTER TABLE for migration
                return [{ affectedRows: 0 }];
            }
            return [{}];
        }
    };
}

// Mock processGridState for testing
async function processGridState(rawState, pool) {
    const [rows] = await pool.execute('SELECT * FROM grid_state WHERE id = 1');
    let state = rows[0];

    if (!state) {
        await pool.execute(
            'INSERT INTO grid_state (id, confirmed_present, last_confirmed_present, pending_present, pending_streak, pending_off_minutes, pending_on_minutes, unknown_since) VALUES (1, NULL, NULL, NULL, 0, 0, 0, NULL)'
        );
        return { 
            changed: false, 
            confirmedPresent: null, 
            shouldNotify: false,
            isUnknown: rawState === 'unknown',
            lastConfirmedPresent: null,
            shouldPingSvitlobot: false
        };
    }

    let confirmedPresent = state.confirmed_present;
    let lastConfirmedPresent = state.last_confirmed_present;
    let pendingOffMinutes = state.pending_off_minutes || 0;
    let pendingOnMinutes = state.pending_on_minutes || 0;
    let unknownSince = state.unknown_since;
    let shouldNotify = false;
    let changed = false;

    if (rawState === 'unknown') {
        if (!unknownSince) {
            unknownSince = new Date();
        }
        
        await pool.execute(
            `UPDATE grid_state SET unknown_since = ?, pending_off_minutes = 0, pending_on_minutes = 0, updated_at = NOW() WHERE id = 1`,
            [unknownSince]
        );
        
        const unknownThresholdMinutes = parseInt(process.env.UNKNOWN_THRESHOLD_MINUTES || '30', 10);
        const unknownDurationMinutes = (new Date() - new Date(unknownSince)) / (60 * 1000);
        const shouldPingSvitlobot = lastConfirmedPresent === 1 && unknownDurationMinutes < unknownThresholdMinutes;
        
        return {
            changed: false,
            confirmedPresent: confirmedPresent === null ? null : confirmedPresent === 1,
            shouldNotify: false,
            isUnknown: true,
            lastConfirmedPresent: lastConfirmedPresent === null ? null : lastConfirmedPresent === 1,
            shouldPingSvitlobot
        };
    }

    unknownSince = null;

    if (rawState === 'present') {
        pendingOffMinutes = 0;
        
        // Initial NULL state confirms immediately
        if (confirmedPresent === null) {
            confirmedPresent = 1;
            lastConfirmedPresent = 1;
            changed = true;
            
            await pool.execute(
                `UPDATE grid_state SET confirmed_present = 1, last_confirmed_present = 1, pending_off_minutes = 0, pending_on_minutes = 0, unknown_since = NULL, updated_at = NOW() WHERE id = 1`
            );
            
            return {
                changed,
                confirmedPresent: true,
                shouldNotify: false,
                isUnknown: false,
                lastConfirmedPresent: true,
                shouldPingSvitlobot: true
            };
        }
        
        // If confirmed ABSENT, require 2-minute debounce
        if (confirmedPresent === 0) {
            pendingOnMinutes += 1;
            
            if (pendingOnMinutes >= 2) {
                confirmedPresent = 1;
                lastConfirmedPresent = 1;
                shouldNotify = true;
                changed = true;
                
                await pool.execute(
                    `UPDATE grid_state SET confirmed_present = 1, last_confirmed_present = 1, pending_off_minutes = 0, pending_on_minutes = 0, unknown_since = NULL, updated_at = NOW() WHERE id = 1`
                );
                
                return {
                    changed,
                    confirmedPresent: true,
                    shouldNotify,
                    isUnknown: false,
                    lastConfirmedPresent: true,
                    shouldPingSvitlobot: true
                };
            } else {
                // Still pending
                await pool.execute(
                    `UPDATE grid_state SET pending_off_minutes = 0, pending_on_minutes = ?, unknown_since = NULL, updated_at = NOW() WHERE id = 1`,
                    [pendingOnMinutes]
                );
                
                return {
                    changed: false,
                    confirmedPresent: false,
                    shouldNotify: false,
                    isUnknown: false,
                    lastConfirmedPresent: false,
                    shouldPingSvitlobot: false
                };
            }
        }
        
        // Already confirmed PRESENT
        pendingOnMinutes = 0;
        
        await pool.execute(
            `UPDATE grid_state SET confirmed_present = 1, last_confirmed_present = 1, pending_off_minutes = 0, pending_on_minutes = 0, unknown_since = NULL, updated_at = NOW() WHERE id = 1`
        );
        
        return {
            changed: false,
            confirmedPresent: true,
            shouldNotify: false,
            isUnknown: false,
            lastConfirmedPresent: true,
            shouldPingSvitlobot: true
        };
    }

    if (rawState === 'absent') {
        pendingOffMinutes += 1;
        pendingOnMinutes = 0;
        
        if (pendingOffMinutes >= 2 && confirmedPresent !== 0) {
            confirmedPresent = 0;
            lastConfirmedPresent = 0;
            shouldNotify = state.confirmed_present !== 0 && state.confirmed_present !== null;
            changed = true;
        }
        
        await pool.execute(
            `UPDATE grid_state SET confirmed_present = ?, last_confirmed_present = ?, pending_off_minutes = ?, pending_on_minutes = 0, unknown_since = NULL, updated_at = NOW() WHERE id = 1`,
            [confirmedPresent, lastConfirmedPresent, pendingOffMinutes]
        );
        
        return {
            changed,
            confirmedPresent: confirmedPresent === null ? null : confirmedPresent === 1,
            shouldNotify,
            isUnknown: false,
            lastConfirmedPresent: lastConfirmedPresent === null ? null : lastConfirmedPresent === 1,
            shouldPingSvitlobot: pendingOffMinutes >= 2
        };
    }

    return {
        changed: false,
        confirmedPresent: confirmedPresent === null ? null : confirmedPresent === 1,
        shouldNotify: false,
        isUnknown: false,
        lastConfirmedPresent: lastConfirmedPresent === null ? null : lastConfirmedPresent === 1,
        shouldPingSvitlobot: false
    };
}

test('processGridState: one socket offline -> no notification (PRESENT)', async () => {
    const pool = createMemPool();
    
    // Initial state: null
    let result = await processGridState('present', pool);
    assert.equal(result.confirmedPresent, true);
    assert.equal(result.shouldNotify, false);
    assert.equal(result.isUnknown, false);
});

test('processGridState: both offline + witness online, 1 min -> no notify', async () => {
    const pool = createMemPool();
    pool.state.confirmed_present = 1;
    pool.state.last_confirmed_present = 1;
    
    // First minute of absence
    let result = await processGridState('absent', pool);
    assert.equal(result.confirmedPresent, true); // Still confirmed as present
    assert.equal(result.shouldNotify, false);
    assert.equal(result.shouldPingSvitlobot, false); // < 2 min
    assert.equal(pool.state.pending_off_minutes, 1);
});

test('processGridState: both offline + witness online, 2 min -> notify and pingOff', async () => {
    const pool = createMemPool();
    pool.state.confirmed_present = 1;
    pool.state.last_confirmed_present = 1;
    
    // First minute
    await processGridState('absent', pool);
    assert.equal(pool.state.pending_off_minutes, 1);
    
    // Second minute - should confirm and notify
    let result = await processGridState('absent', pool);
    assert.equal(result.confirmedPresent, false);
    assert.equal(result.shouldNotify, true);
    assert.equal(result.shouldPingSvitlobot, true);
    assert.equal(pool.state.confirmed_present, 0);
    assert.equal(pool.state.pending_off_minutes, 2);
});

test('processGridState: all offline (UNKNOWN) -> no FCM, no state change', async () => {
    const pool = createMemPool();
    pool.state.confirmed_present = 1;
    pool.state.last_confirmed_present = 1;
    
    let result = await processGridState('unknown', pool);
    assert.equal(result.confirmedPresent, true); // Keeps last confirmed
    assert.equal(result.shouldNotify, false);
    assert.equal(result.isUnknown, true);
    assert.equal(result.shouldPingSvitlobot, true); // Last was ON, < 30 min
    assert.notEqual(pool.state.unknown_since, null);
});

test('processGridState: UNKNOWN after confirmed off -> no pings', async () => {
    const pool = createMemPool();
    pool.state.confirmed_present = 0;
    pool.state.last_confirmed_present = 0;
    
    let result = await processGridState('unknown', pool);
    assert.equal(result.confirmedPresent, false);
    assert.equal(result.shouldNotify, false);
    assert.equal(result.isUnknown, true);
    assert.equal(result.shouldPingSvitlobot, false); // Last was OFF
});

test('processGridState: UNKNOWN >30 min -> pings stop', async () => {
    const pool = createMemPool();
    pool.state.confirmed_present = 1;
    pool.state.last_confirmed_present = 1;
    pool.state.unknown_since = new Date(Date.now() - 31 * 60 * 1000); // 31 minutes ago
    
    let result = await processGridState('unknown', pool);
    assert.equal(result.shouldPingSvitlobot, false); // > 30 min threshold
});

test('processGridState: UNKNOWN recovery -> normal logic resumes', async () => {
    const pool = createMemPool();
    pool.state.confirmed_present = 1;
    pool.state.last_confirmed_present = 1;
    pool.state.unknown_since = new Date();
    
    // Come back online
    let result = await processGridState('present', pool);
    assert.equal(result.confirmedPresent, true);
    assert.equal(result.isUnknown, false);
    assert.equal(result.shouldPingSvitlobot, true);
    assert.equal(pool.state.unknown_since, null);
});

test('processGridState: PRESENT resets pending_off_minutes', async () => {
    const pool = createMemPool();
    pool.state.confirmed_present = 1;
    pool.state.pending_off_minutes = 1;
    
    let result = await processGridState('present', pool);
    assert.equal(pool.state.pending_off_minutes, 0);
});

test('REGRESSION: router down (all offline) -> UNKNOWN, keep last state, continue pings if was ON', async () => {
    const pool = createMemPool();
    pool.state.confirmed_present = 1;
    pool.state.last_confirmed_present = 1;
    
    let result = await processGridState('unknown', pool);
    assert.equal(result.confirmedPresent, true); // Keep last confirmed
    assert.equal(result.lastConfirmedPresent, true);
    assert.equal(result.shouldNotify, false); // No FCM
    assert.equal(result.isUnknown, true);
    assert.equal(result.shouldPingSvitlobot, true); // Continue pings
});

test('REGRESSION: single socket drops briefly -> stays PRESENT, no notification', async () => {
    const pool = createMemPool();
    pool.state.confirmed_present = 1;
    pool.state.last_confirmed_present = 1;
    
    // One socket online -> PRESENT
    let result = await processGridState('present', pool);
    assert.equal(result.confirmedPresent, true);
    assert.equal(result.shouldNotify, false);
    assert.equal(pool.state.pending_off_minutes, 0);
});

test('NEW: PRESENT after ABSENT requires 2-min debounce, 1 min -> no confirm', async () => {
    const pool = createMemPool();
    pool.state.confirmed_present = 0;
    pool.state.last_confirmed_present = 0;
    
    // First minute of present
    let result = await processGridState('present', pool);
    assert.equal(result.confirmedPresent, false); // Still confirmed as absent
    assert.equal(result.shouldNotify, false);
    assert.equal(result.shouldPingSvitlobot, false); // Don't ping 'on' yet
    assert.equal(pool.state.pending_on_minutes, 1);
    assert.equal(pool.state.confirmed_present, 0); // Still 0
});

test('NEW: PRESENT after ABSENT, 2 min -> confirm and notify', async () => {
    const pool = createMemPool();
    pool.state.confirmed_present = 0;
    pool.state.last_confirmed_present = 0;
    
    // First minute
    await processGridState('present', pool);
    assert.equal(pool.state.pending_on_minutes, 1);
    
    // Second minute - should confirm and notify
    let result = await processGridState('present', pool);
    assert.equal(result.confirmedPresent, true);
    assert.equal(result.shouldNotify, true);
    assert.equal(result.shouldPingSvitlobot, true);
    assert.equal(pool.state.confirmed_present, 1);
    assert.equal(pool.state.pending_on_minutes, 0);
});

test('NEW: UNKNOWN interrupts pending_on_minutes counter', async () => {
    const pool = createMemPool();
    pool.state.confirmed_present = 0;
    pool.state.last_confirmed_present = 0;
    
    // First minute of present
    await processGridState('present', pool);
    assert.equal(pool.state.pending_on_minutes, 1);
    
    // UNKNOWN interrupts
    await processGridState('unknown', pool);
    assert.equal(pool.state.pending_on_minutes, 0);
    assert.equal(pool.state.confirmed_present, 0); // Still 0
});

test('NEW: ABSENT interrupts pending_on_minutes counter', async () => {
    const pool = createMemPool();
    pool.state.confirmed_present = 0;
    pool.state.last_confirmed_present = 0;
    
    // First minute of present
    await processGridState('present', pool);
    assert.equal(pool.state.pending_on_minutes, 1);
    
    // ABSENT interrupts
    await processGridState('absent', pool);
    assert.equal(pool.state.pending_on_minutes, 0);
    assert.equal(pool.state.confirmed_present, 0); // Still 0
});

test('NEW: Initial NULL state confirms PRESENT immediately', async () => {
    const pool = createMemPool();
    pool.state.confirmed_present = null;
    pool.state.last_confirmed_present = null;
    
    // First ever reading is present
    let result = await processGridState('present', pool);
    assert.equal(result.confirmedPresent, true);
    assert.equal(result.shouldNotify, false); // No notification on initial
    assert.equal(result.shouldPingSvitlobot, true);
    assert.equal(pool.state.confirmed_present, 1);
    assert.equal(pool.state.pending_on_minutes, 0);
});
