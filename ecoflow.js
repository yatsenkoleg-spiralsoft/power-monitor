const axios = require('axios');

// --- Настройки EcoFlow ---
const ECOFLOW_EMAIL = process.env.ECOFLOW_EMAIL;
const HASHED_PASSWORD = process.env.ECOFLOW_HASHED_PASSWORD;
const BASE_URL = process.env.ECOFLOW_BASE_URL || 'https://api-e.ecoflow.com';
const SPACE_ID = process.env.ECOFLOW_SPACE_ID;

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
        const baseHeaders = {
            'Content-Type': 'application/json',
            platform: 'android',
            lang: 'ru-ru',
        };

        const loginPayload = {
            email: ECOFLOW_EMAIL,
            password2: HASHED_PASSWORD,
            scene: 'IOT_APP',
            userType: 'ECOFLOW',
            appVersion: '6.8.5.1742',
            countryCode: 'UA',
        };

        const loginResponse = await axios.post(`${BASE_URL}/auth/login`, loginPayload, {
            headers: baseHeaders,
        });

        const token = loginResponse.data?.data?.token;
        const userId = loginResponse.data?.data?.user?.userId;

        if (!token || !userId) {
            throw new Error('Не удалось получить токен аутентификации EcoFlow');
        }

        const authHeaders = {
            ...baseHeaders,
            Authorization: `Bearer ${token}`,
        };

        const devicesResponse = await axios.get(`${BASE_URL}/app/user/device`, {
            headers: authHeaders,
        });

        const boundDevices = devicesResponse.data?.data?.bound;
        if (!boundDevices || Object.keys(boundDevices).length === 0) {
            throw new Error('Устройства EcoFlow не найдены для указанного аккаунта');
        }

        const deviceSn = Object.keys(boundDevices)[0];

        const statusPayload = { sns: [deviceSn], spaceId: SPACE_ID };
        const statusResponse = await axios.post(
            `${BASE_URL}/app/space/card/device/status/init`,
            statusPayload,
            { headers: authHeaders }
        );

        const payloadRaw = statusResponse.data?.data?.[0]?.payload;
        let deviceState = {};
        if (payloadRaw) {
            deviceState = typeof payloadRaw === 'string' ? JSON.parse(payloadRaw) : payloadRaw;
        }

        cachedState = deviceState;
        cachedAt = Date.now();
        cachedDeviceSn = deviceSn;

        return {
            deviceState,
            lastUpdate: new Date(cachedAt),
            deviceSn,
        };
    })();

    try {
        const result = await inFlightFetch;
        return result;
    } finally {
        inFlightFetch = null;
    }
}

/**
 * Получает уровень заряда экофлошки в процентах (0-100)
 * @param {boolean} forceRefresh - принудительное обновление (игнорировать кэш)
 * @returns {Promise<number|null>} - уровень заряда от 0 до 100 или null при ошибке
 */
async function getEcoFlowChargeLevel(forceRefresh = false) {
    try {
        const { deviceState } = await fetchEcoFlowStatus(forceRefresh);
        
        // Извлекаем уровень заряда с приоритетом полей
        const soc = deviceState['pd.soc'] ?? 
                   deviceState['bms_bmsStatus.soc'] ?? 
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
    fetchEcoFlowStatus // Экспортируем для возможного использования в будущем
};
