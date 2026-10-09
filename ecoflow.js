const pkg = require('@ecoflow-api/rest-client');
const { RestClient } = pkg;

// --- Настройки EcoFlow ---
const ECOFLOW_ACCESS_KEY = process.env.ECOFLOW_ACCESS_KEY;
const ECOFLOW_SECRET_KEY = process.env.ECOFLOW_SECRET_KEY;
const ECOFLOW_HOST = process.env.ECOFLOW_HOST || 'https://api.ecoflow.com';

// Support for multiple devices:
// - ECOFLOW_DEVICE_SNS: comma-separated list (e.g., "SN1,SN2")
// - ECOFLOW_DEVICE_SN: single device (backward compatibility)
const ECOFLOW_DEVICE_SN = process.env.ECOFLOW_DEVICE_SN; // Legacy: single device
const ECOFLOW_DEVICE_SNS = process.env.ECOFLOW_DEVICE_SNS; // New: comma-separated list

function getConfiguredDevices() {
    const devices = [];
    if (ECOFLOW_DEVICE_SNS) {
        const sns = ECOFLOW_DEVICE_SNS.split(',').map(sn => sn.trim()).filter(Boolean);
        devices.push(...sns);
    }
    if (ECOFLOW_DEVICE_SN && !devices.includes(ECOFLOW_DEVICE_SN)) {
        devices.push(ECOFLOW_DEVICE_SN);
    }
    return devices;
}

// --- Кэш для повторных вызовов (per-device) ---
const CACHE_TTL_MS = 30 * 1000; // 30 секунд
const deviceCache = new Map(); // Map<deviceSn, { state, cachedAt, inFlightFetch }>

/**
 * Выполняет запросы к API EcoFlow и возвращает состояние устройства.
 * Результат кэшируется на короткое время для оптимизации.
 * @param {string} deviceSn - Serial Number устройства
 * @param {boolean} forceRefresh
 * @returns {Promise<{ deviceState: Record<string, any>, lastUpdate: Date, deviceSn: string }>}
 */
async function fetchEcoFlowStatus(deviceSn, forceRefresh = false) {
    if (!ECOFLOW_ACCESS_KEY || !ECOFLOW_SECRET_KEY) {
        throw new Error('EcoFlow не настроен: отсутствуют ECOFLOW_ACCESS_KEY или ECOFLOW_SECRET_KEY');
    }

    if (!deviceSn) {
        throw new Error('EcoFlow не настроен: отсутствует deviceSn');
    }

    let cache = deviceCache.get(deviceSn);
    if (!cache) {
        cache = { state: null, cachedAt: 0, inFlightFetch: null };
        deviceCache.set(deviceSn, cache);
    }

    const now = Date.now();
    if (!forceRefresh && cache.state && now - cache.cachedAt < CACHE_TTL_MS) {
        return {
            deviceState: cache.state,
            lastUpdate: new Date(cache.cachedAt),
            deviceSn,
        };
    }

    if (cache.inFlightFetch) {
        return cache.inFlightFetch;
    }

    cache.inFlightFetch = (async () => {
        try {
            const client = new RestClient({
                accessKey: ECOFLOW_ACCESS_KEY,
                secretKey: ECOFLOW_SECRET_KEY,
                host: ECOFLOW_HOST,
            });

            const response = await client.getDevicePropertiesPlain(deviceSn);
            const deviceState = response?.data || response || {};

            cache.state = deviceState;
            cache.cachedAt = Date.now();

            return {
                deviceState,
                lastUpdate: new Date(cache.cachedAt),
                deviceSn,
            };
        } catch (err) {
            if (err.response) {
                const d = err.response.data;
                const msg = (typeof d === 'object' && d != null) ? (d.msg || d.message || d.error) : (d != null ? String(d) : err.message);
                throw new Error(`EcoFlow API ${err.response.status}: ${msg || err.message}`);
            }
            throw err;
        }
    })();

    try {
        const result = await cache.inFlightFetch;
        return result;
    } finally {
        cache.inFlightFetch = null;
    }
}

/**
 * Извлекает напряжение в сети (В) и потребление на выходах 220 В (Вт) из deviceState.
 * Напряжение: inv.acInVol в мВ → делим на 1000.
 * Потребление (выдача): inv.outputWatts или pd.wattsOutSum (Вт).
 * Зарядка (вход): pd.wattsInSum (Вт) — суммарная мощность на входе.
 * @param {Record<string, any>} deviceState
 * @returns {{ voltageV: number|null, outputW: number|null, inputW: number|null }}
 */
function getPowerFromState(deviceState) {
    if (!deviceState || typeof deviceState !== 'object') {
        return { voltageV: null, outputW: null, inputW: null };
    }
    let voltageV = null;
    const acInVolMv = deviceState['inv.acInVol'];
    if (acInVolMv !== undefined && acInVolMv !== null) {
        const v = Number(acInVolMv) / 1000;
        if (!isNaN(v)) voltageV = v;
    }
    let outputW = null;
    const outW = deviceState['inv.outputWatts'] ?? deviceState['pd.wattsOutSum'];
    if (outW !== undefined && outW !== null) {
        const w = Number(outW);
        if (!isNaN(w)) outputW = w;
    }
    let inputW = null;
    const inW = deviceState['pd.wattsInSum'] ?? deviceState['pd.chgPowerAC'];
    if (inW !== undefined && inW !== null) {
        const w = Number(inW);
        if (!isNaN(w)) inputW = w;
    }
    return { voltageV, outputW, inputW };
}

/** @deprecated используйте getPowerFromState */
function getVoltageAndConsumptionFromState(deviceState) {
    const { voltageV, outputW } = getPowerFromState(deviceState);
    return { voltageV, consumptionW: outputW };
}

/**
 * Один вызов fetch — возвращает заряд, напряжение и потребление экофлошки.
 * @param {boolean} forceRefresh - принудительное обновление (игнорировать кэш)
 * @returns {Promise<{ chargeLevel: number|null, voltageV: number|null, consumptionW: number|null, inputW: number|null }>}
 * @deprecated Use getEcoFlowDataForAllDevices() for multi-device support
 */
async function getEcoFlowVoltageAndConsumption(forceRefresh = false) {
    const devices = getConfiguredDevices();
    if (devices.length === 0 || !ECOFLOW_ACCESS_KEY || !ECOFLOW_SECRET_KEY) {
        return { chargeLevel: null, voltageV: null, consumptionW: null, inputW: null };
    }
    
    // For backward compatibility, return data from the first device
    const deviceSn = devices[0];
    try {
        const { deviceState } = await fetchEcoFlowStatus(deviceSn, forceRefresh);
        const soc = deviceState['pd.soc'] ??
            deviceState['bms_bmsStatus.soc'] ??
            deviceState['bms_emsStatus.lcdShowSoc'] ??
            deviceState.battery_soc;
        let chargeLevel = null;
        if (soc !== undefined && soc !== null) {
            const n = Number(soc);
            if (!isNaN(n)) chargeLevel = Math.max(0, Math.min(100, n));
        }
        const { voltageV, outputW, inputW } = getPowerFromState(deviceState);
        return { chargeLevel, voltageV, consumptionW: outputW, inputW };
    } catch (error) {
        console.error('Ошибка получения данных экофлошки:', error.message);
        return { chargeLevel: null, voltageV: null, consumptionW: null, inputW: null };
    }
}

/**
 * Fetches data for all configured EcoFlow devices.
 * @param {boolean} forceRefresh - force cache refresh
 * @returns {Promise<Array<{ deviceSn: string, deviceId: string, deviceName: string, model: string|null, chargeLevel: number|null, voltageV: number|null, consumptionW: number|null, inputW: number|null, temperatureC: number|null, error: string|null }>>}
 */
async function getEcoFlowDataForAllDevices(forceRefresh = false) {
    const devices = getConfiguredDevices();
    if (devices.length === 0 || !ECOFLOW_ACCESS_KEY || !ECOFLOW_SECRET_KEY) {
        return [];
    }

    const results = await Promise.allSettled(
        devices.map(async (deviceSn, index) => {
            try {
                const { deviceState } = await fetchEcoFlowStatus(deviceSn, forceRefresh);
                
                const soc = deviceState['pd.soc'] ??
                    deviceState['bms_bmsStatus.soc'] ??
                    deviceState['bms_emsStatus.lcdShowSoc'] ??
                    deviceState.battery_soc;
                
                let chargeLevel = null;
                if (soc !== undefined && soc !== null) {
                    const n = Number(soc);
                    if (!isNaN(n)) chargeLevel = Math.max(0, Math.min(100, n));
                }
                
                const { voltageV, outputW, inputW } = getPowerFromState(deviceState);
                
                // Extract temperature
                let temperatureC = null;
                const temp = deviceState['bms_bmsStatus.temp'] ?? deviceState['bms_emsStatus.bmsTemp'];
                if (temp !== undefined && temp !== null) {
                    const t = Number(temp);
                    if (!isNaN(t)) temperatureC = t;
                }
                
                // Extract model (if available)
                const model = deviceState['model'] ?? null;
                
                // Generate simple device ID: "ecoflow" for first, "ecoflow2" for second, etc.
                const deviceId = index === 0 ? 'ecoflow' : `ecoflow${index + 1}`;
                const deviceName = index === 0 ? 'Экофлошка' : `Экофлошка ${index + 1}`;
                
                return {
                    deviceSn,
                    deviceId,
                    deviceName,
                    model,
                    chargeLevel,
                    voltageV,
                    consumptionW: outputW,
                    inputW,
                    temperatureC,
                    error: null,
                };
            } catch (error) {
                console.error(`Ошибка получения данных экофлошки ${deviceSn}:`, error.message);
                const deviceId = index === 0 ? 'ecoflow' : `ecoflow${index + 1}`;
                return {
                    deviceSn,
                    deviceId,
                    deviceName: index === 0 ? 'Экофлошка' : `Экофлошка ${index + 1}`,
                    model: null,
                    chargeLevel: null,
                    voltageV: null,
                    consumptionW: null,
                    inputW: null,
                    temperatureC: null,
                    error: error.message,
                };
            }
        })
    );

    return results.map(result => result.status === 'fulfilled' ? result.value : result.reason);
}

/**
 * Получает уровень заряда экофлошки в процентах (0-100)
 * @param {boolean} forceRefresh - принудительное обновление (игнорировать кэш)
 * @returns {Promise<number|null>} - уровень заряда от 0 до 100 или null при ошибке
 * @deprecated Use getEcoFlowDataForAllDevices() for multi-device support
 */
async function getEcoFlowChargeLevel(forceRefresh = false) {
    const devices = getConfiguredDevices();
    if (devices.length === 0 || !ECOFLOW_ACCESS_KEY || !ECOFLOW_SECRET_KEY) {
        return null;
    }
    try {
        const { deviceState } = await fetchEcoFlowStatus(devices[0], forceRefresh);
        
        const soc = deviceState['pd.soc'] ?? 
                   deviceState['bms_bmsStatus.soc'] ?? 
                   deviceState['bms_emsStatus.lcdShowSoc'] ??
                   deviceState.battery_soc;
        
        if (soc === undefined || soc === null) {
            console.warn('Уровень заряда экофлошки не найден в ответе API');
            return null;
        }
        
        const chargeLevel = Number(soc);
        if (isNaN(chargeLevel)) {
            console.warn('Уровень заряда экофлошки не является числом:', soc);
            return null;
        }
        
        return Math.max(0, Math.min(100, chargeLevel));
    } catch (error) {
        console.error('Ошибка получения уровня заряда экофлошки:', error.message);
        return null;
    }
}

module.exports = {
    getEcoFlowChargeLevel,
    getEcoFlowVoltageAndConsumption,
    getEcoFlowDataForAllDevices,
    getConfiguredDevices,
    fetchEcoFlowStatus
};
