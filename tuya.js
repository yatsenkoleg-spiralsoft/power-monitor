const axios = require('axios');
const crypto = require('crypto');

// Конфигурация из переменных окружения (обязательные параметры)
const ACCESS_ID = process.env.TUYA_ACCESS_ID;
const ACCESS_KEY = process.env.TUYA_ACCESS_KEY;
const API_BASE_URL = process.env.TUYA_API_URL || 'https://openapi.tuyaeu.com';

// ID устройств из переменных окружения или по умолчанию
const DEVICE_IDS = process.env.DEVICE_IDS 
    ? JSON.parse(process.env.DEVICE_IDS)
    : {
        'Розетка 1': 'bf3c70a960958bcf11ruml',
        'Розетка 2': 'bfcbd371e1af7827f9sj79',
        'T & H Sensor': 'bf2bf2252c37a041b0tbvs'
    };

let accessToken = null;
let tokenExpiryTime = null; // Время истечения токена

// Проверка обязательных переменных окружения
if (!ACCESS_ID || !ACCESS_KEY) {
    throw new Error('Требуются переменные окружения: TUYA_ACCESS_ID и TUYA_ACCESS_KEY');
}

/**
 * Подписывает запрос к Tuya API
 */
function signRequest(path, method, query = {}, body = {}, token = null) {
    const t = Date.now().toString();
    const bodyStr = (method === 'POST' || method === 'PUT') ? JSON.stringify(body) : '';
    const contentHash = crypto.createHash('sha256').update(bodyStr).digest('hex').toLowerCase();
    const querySorted = Object.entries(query).sort().map(v => v.join('=')).join('&');
    const urlForSign = querySorted ? `${path}?${querySorted}` : path;
    const stringToSign = `${method}\n${contentHash}\n\n${urlForSign}`;
    const signStr = `${ACCESS_ID}${token || accessToken || ''}${t}${stringToSign}`;
    const sign = crypto.createHmac('sha256', ACCESS_KEY).update(signStr).digest('hex').toUpperCase();
    return { t, sign };
}

/**
 * Получает токен доступа к Tuya API
 */
async function getAccessToken(forceRefresh = false) {
    // Проверяем, не истек ли токен (если есть время истечения)
    if (accessToken && !forceRefresh) {
        if (tokenExpiryTime && Date.now() < tokenExpiryTime) {
            return accessToken;
        }
        // Токен истек или нет информации о времени истечения
        // console.log("Токен истек, запрашиваю новый...");
        accessToken = null;
    }
    
    // console.log("Запрашиваю новый токен доступа Tuya...");
    try {
        const method = 'GET';
        const path = '/v1.0/token';
        const query = { grant_type: 1 };
        const { t, sign } = signRequest(path, method, query, {});
        const headers = {
            'client_id': ACCESS_ID,
            'sign': sign,
            't': t,
            'sign_method': 'HMAC-SHA256'
        };
        
        const response = await axios.get(`${API_BASE_URL}${path}`, {
            headers,
            params: query,
            timeout: 10000 // 10 секунд таймаут
        });
        
        if (response.data && response.data.success) {
            accessToken = response.data.result.access_token;
            // Токен обычно действует 7200 секунд (2 часа), но обновляем за 5 минут до истечения
            const expiresIn = (response.data.result.expire_time || 7200) * 1000; // Конвертируем в миллисекунды
            tokenExpiryTime = Date.now() + expiresIn - (5 * 60 * 1000); // Обновляем за 5 минут до истечения
            // console.log('Токен Tuya успешно получен, истекает через', expiresIn / 1000, 'секунд');
            return accessToken;
        }
        throw new Error(response.data.msg || 'Unknown error');
    } catch (error) {
        console.error('Ошибка получения токена Tuya:', error.message);
        accessToken = null;
        tokenExpiryTime = null;
        throw new Error(`Не удалось получить токен доступа: ${error.message}`);
    }
}

/**
 * Выполняет запрос с автоматическим обновлением токена при ошибке "token invalid"
 */
async function makeTuyaRequest(path, method = 'GET', query = {}, body = {}, retryCount = 0, extraHeaders = {}) {
    const MAX_RETRIES = 1;
    
    try {
        let token = await getAccessToken();
        const { t, sign } = signRequest(path, method, query, body, token);
        
        const headers = {
            'client_id': ACCESS_ID,
            'access_token': token,
            'sign': sign,
            't': t,
            'sign_method': 'HMAC-SHA256',
            ...extraHeaders
        };
        
        const config = {
            headers,
            timeout: 15000
        };
        
        if (method === 'GET') {
            config.params = query;
        }
        
        let response;
        if (method === 'GET') {
            response = await axios.get(`${API_BASE_URL}${path}`, config);
        } else if (method === 'POST') {
            response = await axios.post(`${API_BASE_URL}${path}`, body, config);
        } else if (method === 'PUT') {
            response = await axios.put(`${API_BASE_URL}${path}`, body, config);
        } else {
            throw new Error(`Unsupported method: ${method}`);
        }
        
        // Проверяем, не истек ли токен
        if (response.data && !response.data.success) {
            const errorCode = response.data.code;
            const errorMsg = response.data.msg;
            
            // Ошибка "token invalid" (code 1010) или "token expired" (code 1011)
            if ((errorCode === 1010 || errorCode === 1011) && retryCount < MAX_RETRIES) {
                // console.log(`Токен истек (code: ${errorCode}, msg: ${errorMsg}), обновляю и повторяю запрос...`);
                accessToken = null; // Сбрасываем токен
                tokenExpiryTime = null;
                // Повторяем запрос с новым токеном
                return makeTuyaRequest(path, method, query, body, retryCount + 1, extraHeaders);
            }
            
            // Rate limiting (429) - обычно не должно происходить при мониторинге каждую минуту
            if (errorCode === 429) {
                console.warn('Rate limit достигнут, ожидаю перед повтором...');
                // Не повторяем при rate limit, возвращаем ошибку
                throw new Error('Rate limit exceeded');
            }
        }
        
        return response;
    } catch (error) {
        // Обработка ошибок сети и HTTP ошибок
        if (error.response && error.response.data) {
            const errorCode = error.response.data.code;
            const errorMsg = error.response.data.msg;
            
            if ((errorCode === 1010 || errorCode === 1011) && retryCount < MAX_RETRIES) {
                // console.log(`Токен истек (code: ${errorCode}, msg: ${errorMsg}), обновляю и повторяю запрос...`);
                accessToken = null;
                tokenExpiryTime = null;
                return makeTuyaRequest(path, method, query, body, retryCount + 1, extraHeaders);
            }
        }
        throw error;
    }
}

/**
 * Получает информацию об устройстве (включая онлайн-статус)
 * Endpoint: GET /v1.0/devices/{device_id}
 */
async function getDeviceInfo(deviceId) {
    try {
        const path = `/v1.0/devices/${deviceId}`;
        const response = await makeTuyaRequest(path, 'GET');
        
        if (response.data && response.data.success) {
            return response.data.result;
        }
        return null;
    } catch (error) {
        console.error(`Ошибка получения информации об устройстве ${deviceId}:`, error.message);
        return null;
    }
}

/**
 * Проверяет доступность устройства через Tuya API
 * Возвращает объект с информацией о статусе
 */
const TH_SENSOR_DEVICE_ID = 'bf2bf2252c37a041b0tbvs';

/**
 * Строит объект { code: value } из массива статуса Tuya (result или deviceInfo.status).
 * Элементы могут быть { code, value } или с другими именами полей в зависимости от API.
 */
function buildStatusMap(statusList) {
    if (!statusList || !Array.isArray(statusList)) return {};
    return statusList.reduce((acc, item) => {
        const code = item.code != null ? item.code : item.dp_id;
        const value = item.value != null ? item.value : item.dp_value;
        if (code !== undefined && code !== null) acc[String(code)] = value;
        return acc;
    }, {});
}

/**
 * Извлекает из statusMap потребление (Вт), напряжение (В), температуру (°C), влажность (%).
 * Розетки: cur_power, cur_voltage; va_temperature, va_humidity.
 * T&H Sensor (v2.0 shadow/properties): temp_current (0.1°C, напр. 239→23.9°C), humidity_value (%).
 * Zigbee T&H: DP1/DP2, va_temperature, va_humidity.
 */
function parseStatusMap(statusMap) {
    const powerValue = statusMap['cur_power'] || statusMap['cur_power_1'] || statusMap['power'] || null;
    const powerConsumptionW = powerValue !== null && powerValue !== undefined ? Number(powerValue) / 10 : null;
    const voltageValue = statusMap['cur_voltage'] || null;
    const voltageV = voltageValue !== null && voltageValue !== undefined ? Number(voltageValue) / 10 : null;
    // temp_current (shadow API) — всегда в 0.1°C, делим только на 10. Остальные коды — Zigbee/другие форматы.
    const tempCurrentRaw = statusMap['temp_current'];
    let temperatureC = null;
    if (tempCurrentRaw !== null && tempCurrentRaw !== undefined) {
        const v = Number(tempCurrentRaw);
        if (!isNaN(v)) temperatureC = v / 10;
    }
    if (temperatureC == null) {
        const tempRaw = statusMap['va_temperature'] ?? statusMap['current_temperature'] ?? statusMap['temperature'] ?? statusMap['1'] ?? null;
        if (tempRaw !== null && tempRaw !== undefined) {
            const v = Number(tempRaw);
            if (!isNaN(v)) {
                if (Math.abs(v) > 200) temperatureC = v / 100;
                else if (v > 100) temperatureC = v / 10;
                else temperatureC = v;
            }
        }
    }
    const humRaw = statusMap['humidity_value'] ?? statusMap['va_humidity'] ?? statusMap['humidity'] ?? statusMap['2'] ?? null;
    let humidityPercent = null;
    if (humRaw !== null && humRaw !== undefined) {
        const v = Number(humRaw);
        if (!isNaN(v)) {
            if (v > 1000) humidityPercent = v / 100;
            else if (v > 100) humidityPercent = v / 10;
            else humidityPercent = v;
        }
    }
    return { powerConsumptionW, voltageV, temperatureC, humidityPercent };
}

async function checkDeviceAvailability(deviceId, deviceName = null) {
    const startTime = Date.now();
    let dataSource = 'нет данных';
    
    try {
        const deviceInfo = await getDeviceInfo(deviceId);
        let statusMap = {};
        
        if (deviceId === TH_SENSOR_DEVICE_ID) {
            // Градусник: только shadow/properties (без /status и iot-03).
            // Добавляем cache-bust: уникальный query и заголовки, чтобы уменьшить шанс ответа из кеша Tuya.
            try {
                const pathShadow = `/v2.0/cloud/thing/${deviceId}/shadow/properties`;
                const queryShadow = { _: String(Date.now()) };
                const resShadow = await makeTuyaRequest(pathShadow, 'GET', queryShadow, {}, 0, {
                    'Cache-Control': 'no-cache, no-store',
                    'Pragma': 'no-cache'
                });
                if (resShadow.data && resShadow.data.success && resShadow.data.result && resShadow.data.result.properties) {
                    resShadow.data.result.properties.forEach(p => {
                        if (p.code != null && p.value !== undefined) statusMap[String(p.code)] = p.value;
                    });
                    dataSource = '/v2.0/cloud/thing/{id}/shadow/properties';
                }
            } catch (err) {
                // shadow/properties ошибка — оставляем statusMap пустым
            }
        } else {
            const pathStatus = `/v1.0/devices/${deviceId}/status`;
            const response = await makeTuyaRequest(pathStatus, 'GET');
            if (response.data && response.data.success && response.data.result) {
                statusMap = buildStatusMap(response.data.result);
                dataSource = '/v1.0/devices/{id}/status';
            } else {
                const code = response.data?.code;
                const msg = (response.data?.msg || '').toLowerCase();
                const isFunctionNotSupport = code === 2003 || msg.includes('function not support');
                if (isFunctionNotSupport) {
                    try {
                        const pathIot03 = `/v1.0/iot-03/devices/${deviceId}/status`;
                        const resIot03 = await makeTuyaRequest(pathIot03, 'GET');
                        if (resIot03.data && resIot03.data.success && resIot03.data.result && resIot03.data.result.length) {
                            statusMap = buildStatusMap(resIot03.data.result);
                            dataSource = '/v1.0/iot-03/devices/{id}/status';
                        }
                    } catch (err) {}
                }
                if (Object.keys(statusMap).length === 0 && deviceInfo && Array.isArray(deviceInfo.status) && deviceInfo.status.length > 0) {
                    statusMap = buildStatusMap(deviceInfo.status);
                    dataSource = 'getDeviceInfo.status';
                }
            }
        }
        
        const label = deviceName || deviceId;
        //console.log(`[Tuya] ${label}: данные из ${dataSource}`);
        
        const responseTime = Date.now() - startTime;
        const { powerConsumptionW, voltageV, temperatureC, humidityPercent } = parseStatusMap(statusMap);
        
        let isActuallyOnline = true;
        if (deviceInfo != null) {
            if (deviceInfo.online === false) isActuallyOnline = false;
            else if (deviceInfo.online === true) isActuallyOnline = true;
            else isActuallyOnline = true;
        } else {
            isActuallyOnline = true;
        }
        
        return {
            isOnline: isActuallyOnline,
            responseTimeMs: responseTime,
            powerConsumptionW,
            voltageV,
            temperatureC,
            humidityPercent,
            error: null,
            deviceId,
            deviceName
        };
    } catch (error) {
        const responseTime = Date.now() - startTime;
        
        // Если ошибка сети или таймаут - устройство недоступно (света нет)
        let errorMessage = error.message;
        
        if (error.code === 'ECONNABORTED') {
            errorMessage = 'Timeout';
        } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
            errorMessage = 'Connection error';
        }
        
        return {
            isOnline: false,
            responseTimeMs: null,
            powerConsumptionW: null,
            voltageV: null,
            temperatureC: null,
            humidityPercent: null,
            error: errorMessage,
            deviceId,
            deviceName
        };
    }
}

/**
 * Получает список всех устройств для мониторинга
 */
function getDevices() {
    return Object.entries(DEVICE_IDS).map(([name, id]) => ({
        id,
        name
    }));
}

/**
 * Сбрасывает кеш токена (для тестирования)
 */
function resetToken() {
    accessToken = null;
    tokenExpiryTime = null;
}

module.exports = {
    checkDeviceAvailability,
    getDevices,
    resetToken,
    DEVICE_IDS
};
