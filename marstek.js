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
 * @returns {Promise<Array>} list of devices
 */
async function getDeviceStatus(token) {
    try {
        const response = await axios.get(MARSTEK_STATUS_URL, {
            params: { token },
            timeout: 15000,
        });

        const data = response.data;

        // code 8 = no access (token expired)
        if (data && data.code === 8) {
            throw new Error('TOKEN_EXPIRED');
        }

        if (data && Array.isArray(data.data)) {
            return data.data;
        }

        return [];
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
 * Fetch Marstek battery status with retry on token expiration
 * @param {boolean} forceRefresh
 * @returns {Promise<{ deviceState: Record<string, any>, lastUpdate: Date }>}
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
        };
    }

    if (deviceCache.inFlightFetch) {
        return deviceCache.inFlightFetch;
    }

    deviceCache.inFlightFetch = (async () => {
        try {
            let token = cachedToken;

            // Try with cached token first
            if (!token) {
                token = await login();
            }

            let devices;
            try {
                devices = await getDeviceStatus(token);
            } catch (error) {
                // On token expiration, re-login and retry once
                if (error.message === 'TOKEN_EXPIRED') {
                    console.log('Marstek token expired, re-logging in...');
                    token = await login();
                    devices = await getDeviceStatus(token);
                } else {
                    throw error;
                }
            }

            // Find VNSE3-0 device
            const vnse3Device = devices.find(d => d.type === 'VNSE3-0');
            if (!vnse3Device) {
                throw new Error('Marstek VENUS-E 3.0 device not found in account');
            }

            deviceCache.state = vnse3Device;
            deviceCache.cachedAt = Date.now();

            return {
                deviceState: vnse3Device,
                lastUpdate: new Date(deviceCache.cachedAt),
            };
        } catch (err) {
            throw err;
        }
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
 * @returns {Promise<Array<{ deviceSn: string, deviceId: string, deviceName: string, soc: number|null, charge: number|null, discharge: number|null, load: number|null, pv: number|null, grid: number|null, reportTime: Date|null, error: string|null }>>}
 */
async function getMarstekDataForAllDevices(forceRefresh = false) {
    if (!MARSTEK_EMAIL || !MARSTEK_PASSWORD) {
        return [];
    }

    try {
        const { deviceState } = await fetchMarstekStatus(forceRefresh);

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
            error: null,
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
