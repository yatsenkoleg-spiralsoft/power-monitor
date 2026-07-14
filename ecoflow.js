const pkg = require('@ecoflow-api/rest-client');
const { RestClient } = pkg;

// --- Настройки EcoFlow ---
const ECOFLOW_ACCESS_KEY = process.env.ECOFLOW_ACCESS_KEY;
const ECOFLOW_SECRET_KEY = process.env.ECOFLOW_SECRET_KEY;
const ECOFLOW_HOST = process.env.ECOFLOW_HOST || 'https://api.ecoflow.com';
const ECOFLOW_DEVICE_SN = process.env.ECOFLOW_DEVICE_SN; // Serial Number устройства

// --- Кэш для повторных вызовов ---
const CACHE_TTL_MS = 30 * 1000; // 30 секунд
let cachedState = null;
let cachedAt = 0;
let cachedDeviceSn = null;
let inFlightFetch = null;

/**
 * Выполняет запросы к API EcoFlow и возвращает состояние устройства.
 * Результат кэшируется на короткое время для оптимизации.
 * @param {boolean} forceRefresh
 * @returns {Promise<{ deviceState: Record<string, any>, lastUpdate: Date, deviceSn: string | null }>}
 */
async function fetchEcoFlowStatus(forceRefresh = false) {
    if (!ECOFLOW_ACCESS_KEY || !ECOFLOW_SECRET_KEY) {
        throw new Error('EcoFlow не настроен: отсутствуют ECOFLOW_ACCESS_KEY или ECOFLOW_SECRET_KEY');
    }

    if (!ECOFLOW_DEVICE_SN) {
        throw new Error('EcoFlow не настроен: отсутствует ECOFLOW_DEVICE_SN');
    }

    const now = Date.now();
    if (!forceRefresh && cachedState && now - cachedAt < CACHE_TTL_MS) {
        return {
            deviceState: cachedState,
            lastUpdate: new Date(cachedAt),
            deviceSn: cachedDeviceSn,
        };
    }

    if (inFlightFetch) {
        return inFlightFetch;
    }

    inFlightFetch = (async () => {
        try {
            const client = new RestClient({
                accessKey: ECOFLOW_ACCESS_KEY,
                secretKey: ECOFLOW_SECRET_KEY,
                host: ECOFLOW_HOST,
            });

            // Получаем все параметры устройства
            const response = await client.getDevicePropertiesPlain(ECOFLOW_DEVICE_SN);
            const deviceState = response?.data || response || {};

            cachedState = deviceState;
            cachedAt = Date.now();
            cachedDeviceSn = ECOFLOW_DEVICE_SN;

            return {
                deviceState,
                lastUpdate: new Date(cachedAt),
                deviceSn: ECOFLOW_DEVICE_SN,
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
        const result = await inFlightFetch;
        return result;
    } finally {
        inFlightFetch = null;
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
 */
async function getEcoFlowVoltageAndConsumption(forceRefresh = false) {
    if (!ECOFLOW_ACCESS_KEY || !ECOFLOW_SECRET_KEY || !ECOFLOW_DEVICE_SN) {
        return { chargeLevel: null, voltageV: null, consumptionW: null, inputW: null };
    }
    try {
        const { deviceState } = await fetchEcoFlowStatus(forceRefresh);
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
 * Получает уровень заряда экофлошки в процентах (0-100)
 * @param {boolean} forceRefresh - принудительное обновление (игнорировать кэш)
 * @returns {Promise<number|null>} - уровень заряда от 0 до 100 или null при ошибке
 */
async function getEcoFlowChargeLevel(forceRefresh = false) {
    if (!ECOFLOW_ACCESS_KEY || !ECOFLOW_SECRET_KEY || !ECOFLOW_DEVICE_SN) {
        return null; // EcoFlow не настроен — не логируем
    }
    try {
        const { deviceState } = await fetchEcoFlowStatus(forceRefresh);
        
        // Извлекаем уровень заряда с приоритетом полей
        const soc = deviceState['pd.soc'] ?? 
                   deviceState['bms_bmsStatus.soc'] ?? 
                   deviceState['bms_emsStatus.lcdShowSoc'] ??
                   deviceState.battery_soc;
        
        if (soc === undefined || soc === null) {
            console.warn('Уровень заряда экофлошки не найден в ответе API');
            return null;
        }
        
        // Преобразуем в число и проверяем диапазон
        const chargeLevel = Number(soc);
        if (isNaN(chargeLevel)) {
            console.warn('Уровень заряда экофлошки не является числом:', soc);
            return null;
        }
        
        // Ограничиваем диапазон 0-100
        return Math.max(0, Math.min(100, chargeLevel));
    } catch (error) {
        // Не падаем при ошибке - просто логируем и возвращаем null
        console.error('Ошибка получения уровня заряда экофлошки:', error.message);
        return null;
    }
}

module.exports = {
    getEcoFlowChargeLevel,
    getEcoFlowVoltageAndConsumption,
    fetchEcoFlowStatus
};
