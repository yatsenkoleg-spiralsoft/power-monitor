const test = require('node:test');
const assert = require('node:assert');
const axios = require('axios');

// Mock environment variables
process.env.MARSTEK_EMAIL = 'test@example.com';
process.env.MARSTEK_PASSWORD = 'testpassword';
process.env.MARSTEK_POLL_INTERVAL_MS = '300000';

// Track console output
const consoleLogs = [];
const consoleErrors = [];
const consoleWarns = [];
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function captureConsole() {
    consoleLogs.length = 0;
    consoleErrors.length = 0;
    consoleWarns.length = 0;
    console.log = (...args) => { consoleLogs.push(args.join(' ')); };
    console.error = (...args) => { consoleErrors.push(args.join(' ')); };
    console.warn = (...args) => { consoleWarns.push(args.join(' ')); };
}

function restoreConsole() {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
}

// Mock axios
let axiosGetMock = null;
const originalAxiosGet = axios.get;

function mockAxiosGet(fn) {
    axiosGetMock = fn;
    axios.get = fn;
}

function restoreAxios() {
    axios.get = originalAxiosGet;
    axiosGetMock = null;
}

// Clear module cache to get fresh module state between tests
function freshMarstekModule() {
    delete require.cache[require.resolve('../marstek.js')];
    return require('../marstek.js');
}

test('Marstek: successful device fetch', async () => {
    captureConsole();
    const marstek = freshMarstekModule();
    
    let callCount = 0;
    mockAxiosGet(async (url, config) => {
        callCount++;
        if (url.includes('v2_get_device.php')) {
            // Login request
            return {
                data: { code: '2', token: 'test-token-123', msg: 'ok' },
            };
        } else if (url.includes('getDeviceList')) {
            // Status request
            return {
                data: {
                    code: 1,
                    msg: 'ok',
                    data: [
                        {
                            type: 'VNSE3-0',
                            sn: 'TEST123',
                            devid: 'device-1',
                            soc: 85,
                            charge: 250,
                            discharge: 100,
                            load: 150,
                            pv: 500,
                            grid: 0,
                            report_time: 1731160000,
                        },
                    ],
                },
            };
        }
        throw new Error('Unexpected URL');
    });
    
    try {
        const result = await marstek.getMarstekDataForAllDevices();
        
        assert.equal(result.length, 1);
        assert.equal(result[0].deviceId, 'marstek');
        assert.equal(result[0].deviceName, 'Marstek VENUS-E 3.0');
        assert.equal(result[0].soc, 85);
        assert.equal(result[0].charge, 250);
        assert.equal(result[0].discharge, 100);
        assert.equal(result[0].load, 150);
        assert.equal(result[0].pv, 500);
        assert.equal(result[0].grid, 0);
        assert.equal(result[0].error, null);
        assert.equal(result[0].fromGracePeriod, false);
        
        // Should have made login + status calls
        assert.equal(callCount, 2);
    } finally {
        restoreAxios();
        restoreConsole();
    }
});

test('Marstek: token expiration triggers re-login and retry', async () => {
    captureConsole();
    const marstek = freshMarstekModule();
    
    let callCount = 0;
    let loginCount = 0;
    mockAxiosGet(async (url, config) => {
        callCount++;
        if (url.includes('v2_get_device.php')) {
            // Login request
            loginCount++;
            return {
                data: { code: '2', token: `test-token-${loginCount}`, msg: 'ok' },
            };
        } else if (url.includes('getDeviceList')) {
            // First status request returns expired token error
            if (callCount === 2) {
                return {
                    data: { code: 8, msg: 'no access', data: [] },
                };
            }
            // Second status request succeeds
            return {
                data: {
                    code: 1,
                    msg: 'ok',
                    data: [
                        { type: 'VNSE3-0', sn: 'TEST123', soc: 75, charge: 200, discharge: 50, load: 100, pv: 300, grid: 0, report_time: 1731160000 },
                    ],
                },
            };
        }
        throw new Error('Unexpected URL');
    });
    
    try {
        const result = await marstek.getMarstekDataForAllDevices();
        
        assert.equal(result.length, 1);
        assert.equal(result[0].soc, 75);
        assert.equal(result[0].fromGracePeriod, false);
        
        // Should have made: login + status (expired) + re-login + status (success)
        assert.equal(loginCount, 2);
        assert.equal(callCount, 4);
        
        // Check for re-login message in logs
        const hasReloginLog = consoleLogs.some(log => log.includes('token expired'));
        assert.equal(hasReloginLog, true);
    } finally {
        restoreAxios();
        restoreConsole();
    }
});

test('Marstek: missing device triggers re-login and retry', async () => {
    captureConsole();
    const marstek = freshMarstekModule();
    
    let callCount = 0;
    let loginCount = 0;
    mockAxiosGet(async (url, config) => {
        callCount++;
        if (url.includes('v2_get_device.php')) {
            loginCount++;
            return {
                data: { code: '2', token: `test-token-${loginCount}`, msg: 'ok' },
            };
        } else if (url.includes('getDeviceList')) {
            // First status request returns empty device list
            if (callCount === 2) {
                return {
                    data: { code: 1, msg: 'ok', data: [] },
                };
            }
            // Second status request (after retry) succeeds
            return {
                data: {
                    code: 1,
                    msg: 'ok',
                    data: [
                        { type: 'VNSE3-0', sn: 'TEST123', soc: 80, charge: 220, discharge: 60, load: 120, pv: 350, grid: 0, report_time: 1731160000 },
                    ],
                },
            };
        }
        throw new Error('Unexpected URL');
    });
    
    try {
        const result = await marstek.getMarstekDataForAllDevices();
        
        assert.equal(result.length, 1);
        assert.equal(result[0].soc, 80);
        assert.equal(result[0].fromGracePeriod, false);
        
        // Should have made: login + status (empty) + re-login + status (success)
        assert.equal(loginCount, 2);
        assert.equal(callCount, 4);
        
        // Check for warning about device not found
        const hasWarning = consoleWarns.some(log => log.includes('device not found'));
        assert.equal(hasWarning, true);
    } finally {
        restoreAxios();
        restoreConsole();
    }
});

test('Marstek: transient failure serves from grace period', async () => {
    captureConsole();
    const marstek = freshMarstekModule();
    
    let callCount = 0;
    let failureMode = false;
    
    mockAxiosGet(async (url, config) => {
        callCount++;
        if (url.includes('v2_get_device.php')) {
            return {
                data: { code: '2', token: 'test-token-123', msg: 'ok' },
            };
        } else if (url.includes('getDeviceList')) {
            if (!failureMode) {
                // First call succeeds - this establishes the lastGoodReading
                return {
                    data: {
                        code: 1,
                        msg: 'ok',
                        data: [
                            { type: 'VNSE3-0', sn: 'TEST123', soc: 90, charge: 300, discharge: 80, load: 180, pv: 600, grid: 0, report_time: 1731160000 },
                        ],
                    },
                };
            } else {
                // Subsequent calls return empty list (transient failure)
                return {
                    data: { code: 1, msg: 'ok', data: [] },
                };
            }
        }
        throw new Error('Unexpected URL');
    });
    
    try {
        // First fetch: establish good reading
        const result1 = await marstek.getMarstekDataForAllDevices(true);
        assert.equal(result1.length, 1);
        assert.equal(result1[0].soc, 90);
        assert.equal(result1[0].fromGracePeriod, false);
        
        // Enable failure mode
        failureMode = true;
        
        // Second fetch: should serve from grace period after retries
        const result2 = await marstek.getMarstekDataForAllDevices(true);
        assert.equal(result2.length, 1);
        assert.equal(result2[0].soc, 90); // Same as first reading
        assert.equal(result2[0].fromGracePeriod, true);
        assert.equal(result2[0].error, 'Using cached data (cloud temporarily unavailable)');
        
        // Check for warning about serving from cache
        const hasCacheWarning = consoleWarns.some(log => log.includes('Serving last good reading'));
        assert.equal(hasCacheWarning, true);
    } finally {
        restoreAxios();
        restoreConsole();
    }
});

test('Marstek: failure beyond grace period throws error', async () => {
    captureConsole();
    const marstek = freshMarstekModule();
    
    let callCount = 0;
    mockAxiosGet(async (url, config) => {
        callCount++;
        if (url.includes('v2_get_device.php')) {
            return {
                data: { code: '2', token: 'test-token-123', msg: 'ok' },
            };
        } else if (url.includes('getDeviceList')) {
            // Always return empty list (no prior good reading)
            return {
                data: { code: 1, msg: 'ok', data: [] },
            };
        }
        throw new Error('Unexpected URL');
    });
    
    try {
        const result = await marstek.getMarstekDataForAllDevices();
        
        // Should return error result
        assert.equal(result.length, 1);
        assert.equal(result[0].soc, null);
        assert.equal(result[0].fromGracePeriod, false);
        assert.ok(result[0].error.includes('device not found'));
        
        // Check for error logged
        const hasError = consoleErrors.some(log => log.includes('Ошибка получения данных Marstek'));
        assert.equal(hasError, true);
    } finally {
        restoreAxios();
        restoreConsole();
    }
});

test('Marstek: unexpected cloud response code is logged', async () => {
    captureConsole();
    const marstek = freshMarstekModule();
    
    let callCount = 0;
    mockAxiosGet(async (url, config) => {
        callCount++;
        if (url.includes('v2_get_device.php')) {
            return {
                data: { code: '2', token: 'test-token-123', msg: 'ok' },
            };
        } else if (url.includes('getDeviceList')) {
            // Return unexpected code
            return {
                data: { code: 99, msg: 'unexpected error', data: [] },
            };
        }
        throw new Error('Unexpected URL');
    });
    
    try {
        const result = await marstek.getMarstekDataForAllDevices();
        
        // Should return error result
        assert.equal(result.length, 1);
        assert.equal(result[0].error !== null, true);
        
        // Check for warning about unexpected response
        const hasUnexpectedWarning = consoleWarns.some(log => 
            log.includes('unexpected response') && log.includes('code=99')
        );
        assert.equal(hasUnexpectedWarning, true);
    } finally {
        restoreAxios();
        restoreConsole();
    }
});

test('Marstek: cache prevents redundant API calls', async () => {
    captureConsole();
    const marstek = freshMarstekModule();
    
    let callCount = 0;
    mockAxiosGet(async (url, config) => {
        callCount++;
        if (url.includes('v2_get_device.php')) {
            return {
                data: { code: '2', token: 'test-token-123', msg: 'ok' },
            };
        } else if (url.includes('getDeviceList')) {
            return {
                data: {
                    code: 1,
                    msg: 'ok',
                    data: [
                        { type: 'VNSE3-0', sn: 'TEST123', soc: 85, charge: 250, discharge: 100, load: 150, pv: 500, grid: 0, report_time: 1731160000 },
                    ],
                },
            };
        }
        throw new Error('Unexpected URL');
    });
    
    try {
        // First fetch
        const result1 = await marstek.getMarstekDataForAllDevices();
        assert.equal(result1[0].soc, 85);
        const initialCallCount = callCount;
        
        // Second fetch without forceRefresh (should use cache)
        const result2 = await marstek.getMarstekDataForAllDevices();
        assert.equal(result2[0].soc, 85);
        assert.equal(callCount, initialCallCount, 'Should not make additional API calls when cache is fresh');
        
        // Third fetch with forceRefresh (should make API calls)
        const result3 = await marstek.getMarstekDataForAllDevices(true);
        assert.equal(result3[0].soc, 85);
        assert.ok(callCount > initialCallCount, 'Should make API calls when forceRefresh is true');
    } finally {
        restoreAxios();
        restoreConsole();
    }
});

test('Marstek: no credentials returns empty array', async () => {
    // Temporarily unset credentials
    const savedEmail = process.env.MARSTEK_EMAIL;
    const savedPassword = process.env.MARSTEK_PASSWORD;
    delete process.env.MARSTEK_EMAIL;
    delete process.env.MARSTEK_PASSWORD;
    
    try {
        const marstek = freshMarstekModule();
        const result = await marstek.getMarstekDataForAllDevices();
        assert.deepStrictEqual(result, []);
    } finally {
        // Restore credentials
        process.env.MARSTEK_EMAIL = savedEmail;
        process.env.MARSTEK_PASSWORD = savedPassword;
    }
});

test('Marstek: isMarstekEnabled checks credentials', () => {
    const marstek = freshMarstekModule();
    
    assert.equal(marstek.isMarstekEnabled(), true);
    
    const savedEmail = process.env.MARSTEK_EMAIL;
    delete process.env.MARSTEK_EMAIL;
    
    // Need fresh module to see env change
    delete require.cache[require.resolve('../marstek.js')];
    const marstek2 = require('../marstek.js');
    assert.equal(marstek2.isMarstekEnabled(), false);
    
    process.env.MARSTEK_EMAIL = savedEmail;
});

test('Marstek: getPollIntervalMs returns configured value', () => {
    const marstek = freshMarstekModule();
    assert.equal(marstek.getPollIntervalMs(), 300000);
});

console.log('All Marstek tests passed!');
