const axios = require('axios');
const crypto = require('crypto');

// --- Настройки Marstek ---
const MARSTEK_EMAIL = process.env.MARSTEK_EMAIL;
const MARSTEK_PASSWORD = process.env.MARSTEK_PASSWORD;
const MARSTEK_POLL_INTERVAL_MS = parseInt(process.env.MARSTEK_POLL_INTERVAL_MS || '300000', 10); // 5 min default
const MARSTEK_LOGIN_URL = 'https://eu.hamedata.com/app/Solar/v2_get_device.php';
const MARSTEK_STATUS_URL = 'https://eu.hamedata.com/ems/api/v1/getDeviceList';

// Cache token between polls
let cachedToken = null;
let tokenCachedAt = 0;

// Cache status for short duration
const CACHE_TTL_MS = 30 * 1000; // 30 seconds
let deviceCache = { state: null, cachedAt: 0, inFlightFetch: null };

// Last good reading cache for grace period during transient failures
const GRACE_PERIOD_MS = 15 * 60 * 1000; // 15 minutes
let lastGoodReading = { state: null, cachedAt: 0 };

/**
 * Compute MD5 hash for password
 * @param {string} password
 * @returns {string}
 */
function md5Hash(password) {
    return crypto.createHash('md5').update(password).digest('hex');
}

/**
 * Login to Marstek cloud and get token
 * @returns {Promise<string>} token
 */
async function login() {
    if (!MARSTEK_EMAIL || !MARSTEK_PASSWORD) {
        throw new Error('Marstek не настроен: отсутствуют MARSTEK_EMAIL или MARSTEK_PASSWORD');
    }

    const passwordMd5 = md5Hash(MARSTEK_PASSWORD);
    const url = `${MARSTEK_LOGIN_URL}?pwd=${passwordMd5}&mailbox=${encodeURIComponent(MARSTEK_EMAIL)}`;

    try {
        const response = await axios.get(url, { timeout: 10000 });
        const data = response.data;

        // code "2" = success
        if (data && data.code === '2' && data.token) {
            cachedToken = data.token;
            tokenCachedAt = Date.now();
            return data.token;
        }

        throw new Error(`Marstek login failed: code=${data?.code}, msg=${data?.msg || 'unknown'}`);
    } catch (error) {
        if (error.response) {
            throw new Error(`Marstek login HTTP ${error.response.status}: ${error.response.statusText}`);
        }
        throw error;
    }
}

/**
 * Get device status from Marstek cloud
 * @param {string} token
 * @returns {Promise<{ devices: Array, rawCode: number|string|null, rawMsg: string|null }>}
 */
async function getDeviceStatus(token) {
    try {
        const response = await axios.get(MARSTEK_STATUS_URL, {
            params: { token },
            timeout: 15000,
        });

        const data = response.data;
        const rawCode = data?.code ?? null;
        const rawMsg = data?.msg ?? null;

        // code 8 = no access (token expired)
        if (data && data.code === 8) {
            throw new Error('TOKEN_EXPIRED');
        }

        // code 1 = ok/success based on observed behavior
        if (data && data.code === 1 && Array.isArray(data.data)) {
            return { devices: data.data, rawCode, rawMsg };
        }

        // Unexpected response: log code/msg for diagnosis
        console.warn(`Marstek getDeviceList unexpected response: code=${rawCode}, msg=${rawMsg}`);
        return { devices: [], rawCode, rawMsg };
    } catch (error) {
        if (error.message === 'TOKEN_EXPIRED') {
            throw error;
        }
        if (error.response) {
            throw new Error(`Marstek status HTTP ${error.response.status}: ${error.response.statusText}`);
        }
        throw error;
    }
}

/**
 * Fetch Marstek battery status with retry on token expiration and resilience for transient failures
 * @param {boolean} forceRefresh
 * @returns {Promise<{ deviceState: Record<string, any>, lastUpdate: Date, fromGracePeriod: boolean }>}
 */
async function fetchMarstekStatus(forceRefresh = false) {
    if (!MARSTEK_EMAIL || !MARSTEK_PASSWORD) {
        throw new Error('Marstek не настроен: отсутствуют MARSTEK_EMAIL или MARSTEK_PASSWORD');
    }

    const now = Date.now();
    if (!forceRefresh && deviceCache.state && now - deviceCache.cachedAt < CACHE_TTL_MS) {
        return {
            deviceState: deviceCache.state,
            lastUpdate: new Date(deviceCache.cachedAt),
            fromGracePeriod: false,
        };
    }

    if (deviceCache.inFlightFetch) {
        return deviceCache.inFlightFetch;
    }

    deviceCache.inFlightFetch = (async () => {
        let token = cachedToken;
        let retryCount = 0;
        const MAX_RETRIES = 1;

        while (retryCount <= MAX_RETRIES) {
            try {
                // Try with cached token first, or login if no token
                if (!token) {
                    token = await login();
                }

                let result;
                try {
                    result = await getDeviceStatus(token);
                } catch (error) {
                    // On token expiration, re-login and retry once
                    if (error.message === 'TOKEN_EXPIRED') {
                        console.log('Marstek token expired, re-logging in...');
                        token = await login();
                        result = await getDeviceStatus(token);
                    } else {
                        throw error;
                    }
                }

                const { devices, rawCode, rawMsg } = result;

                // Find VNSE3-0 device
                const vnse3Device = devices.find(d => d.type === 'VNSE3-0');
                if (!vnse3Device) {
                    // Device not found: could be transient issue with cloud API
                    // Log the response for diagnosis (without logging the token)
                    console.warn(`Marstek VENUS-E 3.0 device not found. Cloud response: code=${rawCode}, msg=${rawMsg}, deviceCount=${devices.length}`);
                    
                    // If this is first attempt, retry once with fresh login
                    if (retryCount < MAX_RETRIES) {
                        console.log('Marstek device not found, re-logging in and retrying...');
                        retryCount++;
                        token = await login();
                        continue;
                    }
                    
                    // All retries exhausted. Check if we have a recent good reading within grace period
                    if (lastGoodReading.state && now - lastGoodReading.cachedAt < GRACE_PERIOD_MS) {
                        const age = Math.round((now - lastGoodReading.cachedAt) / 1000);
                        console.warn(`Marstek device not found after retry. Serving last good reading from ${age}s ago (within grace period).`);
                        return {
                            deviceState: lastGoodReading.state,
                            lastUpdate: new Date(lastGoodReading.cachedAt),
                            fromGracePeriod: true,
                        };
                    }
                    
                    // No good reading within grace period, throw error
                    throw new Error(`Marstek VENUS-E 3.0 device not found in account (cloud code=${rawCode})`);
                }

                // Success: update both caches
                deviceCache.state = vnse3Device;
                deviceCache.cachedAt = Date.now();
                lastGoodReading.state = vnse3Device;
                lastGoodReading.cachedAt = deviceCache.cachedAt;

                return {
                    deviceState: vnse3Device,
                    lastUpdate: new Date(deviceCache.cachedAt),
                    fromGracePeriod: false,
                };
            } catch (err) {
                // If we've exhausted retries, check grace period as fallback
                if (retryCount >= MAX_RETRIES) {
                    if (lastGoodReading.state && now - lastGoodReading.cachedAt < GRACE_PERIOD_MS) {
                        const age = Math.round((now - lastGoodReading.cachedAt) / 1000);
                        console.warn(`Marstek fetch failed: ${err.message}. Serving last good reading from ${age}s ago (within grace period).`);
                        return {
                            deviceState: lastGoodReading.state,
                            lastUpdate: new Date(lastGoodReading.cachedAt),
                            fromGracePeriod: true,
                        };
                    }
                    throw err;
                }
                
                // For unexpected errors on first attempt, retry once
                if (retryCount < MAX_RETRIES && err.message !== 'TOKEN_EXPIRED') {
                    console.warn(`Marstek fetch error on attempt ${retryCount + 1}: ${err.message}. Retrying...`);
                    retryCount++;
                    token = null; // Force fresh login on retry
                    continue;
                }
                
                throw err;
            }
        }

        // Should not reach here, but for safety
        throw new Error('Marstek fetch: max retries exhausted');
    })();

    try {
        const result = await deviceCache.inFlightFetch;
        return result;
    } finally {
        deviceCache.inFlightFetch = null;
    }
}

/**
 * Get Marstek battery data for all configured devices
 * @param {boolean} forceRefresh
 * @returns {Promise<Array<{ deviceSn: string, deviceId: string, deviceName: string, soc: number|null, charge: number|null, discharge: number|null, load: number|null, pv: number|null, grid: number|null, reportTime: Date|null, error: string|null, fromGracePeriod: boolean }>>}
 */
async function getMarstekDataForAllDevices(forceRefresh = false) {
    if (!MARSTEK_EMAIL || !MARSTEK_PASSWORD) {
        return [];
    }

    try {
        const { deviceState, fromGracePeriod } = await fetchMarstekStatus(forceRefresh);

        const soc = deviceState.soc != null ? Number(deviceState.soc) : null;
        const charge = deviceState.charge != null ? Number(deviceState.charge) : null;
        const discharge = deviceState.discharge != null ? Number(deviceState.discharge) : null;
        const load = deviceState.load != null ? Number(deviceState.load) : null;
        const pv = deviceState.pv != null ? Number(deviceState.pv) : null;
        const grid = deviceState.grid != null ? Number(deviceState.grid) : null;
        const reportTime = deviceState.report_time ? new Date(deviceState.report_time * 1000) : null;

        return [{
            deviceSn: deviceState.sn || deviceState.devid || 'unknown',
            deviceId: 'marstek',
            deviceName: 'Marstek VENUS-E 3.0',
            soc: soc !== null && !isNaN(soc) ? Math.max(0, Math.min(100, soc)) : null,
            charge: charge !== null && !isNaN(charge) ? charge : null,
            discharge: discharge !== null && !isNaN(discharge) ? discharge : null,
            load: load !== null && !isNaN(load) ? load : null,
            pv: pv !== null && !isNaN(pv) ? pv : null,
            grid: grid !== null && !isNaN(grid) ? grid : null,
            reportTime,
            error: fromGracePeriod ? 'Using cached data (cloud temporarily unavailable)' : null,
            fromGracePeriod,
        }];
    } catch (error) {
        console.error('Ошибка получения данных Marstek:', error.message);
        return [{
            deviceSn: 'unknown',
            deviceId: 'marstek',
            deviceName: 'Marstek VENUS-E 3.0',
            soc: null,
            charge: null,
            discharge: null,
            load: null,
            pv: null,
            grid: null,
            reportTime: null,
            error: error.message,
            fromGracePeriod: false,
        }];
    }
}

/**
 * Check if Marstek monitoring is enabled
 * @returns {boolean}
 */
function isMarstekEnabled() {
    return !!(MARSTEK_EMAIL && MARSTEK_PASSWORD);
}

/**
 * Get poll interval in milliseconds
 * @returns {number}
 */
function getPollIntervalMs() {
    return MARSTEK_POLL_INTERVAL_MS;
}

module.exports = {
    getMarstekDataForAllDevices,
    isMarstekEnabled,
    getPollIntervalMs,
    fetchMarstekStatus,
};
