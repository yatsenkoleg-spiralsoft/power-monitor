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
        'Розетка 2': 'bfcbd371e1af7827f9sj79'
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
async function makeTuyaRequest(path, method = 'GET', query = {}, body = {}, retryCount = 0) {
    const MAX_RETRIES = 1;
    
    try {
        let token = await getAccessToken();
        const { t, sign } = signRequest(path, method, query, body, token);
        
        const headers = {
            'client_id': ACCESS_ID,
            'access_token': token,
            'sign': sign,
            't': t,
            'sign_method': 'HMAC-SHA256'
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
                return makeTuyaRequest(path, method, query, body, retryCount + 1);
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
                return makeTuyaRequest(path, method, query, body, retryCount + 1);
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
async function checkDeviceAvailability(deviceId, deviceName = null) {
    const startTime = Date.now();
    
    try {
        // Получаем информацию об устройстве для проверки реального онлайн-статуса
        const deviceInfo = await getDeviceInfo(deviceId);
        // console.log(`[${deviceId}] Информация об устройстве:`, JSON.stringify(deviceInfo, null, 2));
        
        // Получаем статус устройства через makeTuyaRequest (с автоматическим обновлением токена)
        const path = `/v1.0/devices/${deviceId}/status`;
        const response = await makeTuyaRequest(path, 'GET');
        
        const responseTime = Date.now() - startTime;
        
        // Логируем полный ответ API для диагностики
        // console.log(`[${deviceId}] Полный ответ Tuya API (status):`, JSON.stringify(response.data, null, 2));
        
        if (response.data && response.data.success) {
            // Извлекаем данные о потреблении
            // Проверяем, что result существует и является массивом
            const result = response.data.result || [];
            const statusMap = Array.isArray(result) ? result.reduce((acc, { code, value }) => {
                acc[code] = value;
                return acc;
            }, {}) : {};
            
            // Получаем потребление (cur_power приходит в десятых долях ватта, делим на 10)
            // Также проверяем другие возможные коды для потребления
            const powerValue = statusMap['cur_power'] || statusMap['cur_power_1'] || statusMap['power'] || null;
            const powerConsumptionW = powerValue !== null && powerValue !== undefined ? powerValue / 10 : null;
            
            // Получаем напряжение (cur_voltage приходит в десятых долях вольта, делим на 10)
            const voltageValue = statusMap['cur_voltage'] || null;
            const voltageV = voltageValue !== null && voltageValue !== undefined ? voltageValue / 10 : null;
            
            // Логируем для отладки
            // console.log(`[${deviceId}] Данные о потреблении:`, {
            //     statusMap,
            //     powerValue,
            //     powerConsumptionW,
            //     hasCurPower: 'cur_power' in statusMap,
            //     resultLength: result.length
            // });
            
            // Проверяем реальный онлайн-статус из информации об устройстве
            // Поле online может быть true/false или отсутствовать
            // Также проверяем active_time - если устройство недавно было активно, значит онлайн
            const deviceOnlineStatus = deviceInfo?.online;
            const activeTime = deviceInfo?.active_time;
            
            // Если deviceInfo успешно получена и online === false - устройство точно офлайн
            // Если online === true или не указано, но API ответил успешно - считаем онлайн
            let isActuallyOnline = true;
            
            if (deviceInfo !== null) {
                // Если явно указано online === false - устройство офлайн
                if (deviceOnlineStatus === false) {
                    isActuallyOnline = false;
                    // console.log(`[${deviceId}] Устройство офлайн (deviceInfo.online = false)`);
                } else if (deviceOnlineStatus === true) {
                    isActuallyOnline = true;
                    // console.log(`[${deviceId}] Устройство онлайн (deviceInfo.online = true)`);
                } else {
                    // Если online не указано, но есть active_time - можно проверить свежесть данных
                    // Пока считаем онлайн, если API ответил успешно
                    isActuallyOnline = true;
                    // console.log(`[${deviceId}] Статус online не указан, используем статус API ответа`);
                }
            } else {
                // Если не удалось получить deviceInfo, используем успешность ответа API
                // console.log(`[${deviceId}] Не удалось получить deviceInfo, используем статус API ответа`);
                isActuallyOnline = true;
            }
            
            // Логируем анализ
            // console.log(`[${deviceId}] Анализ данных:`, {
            //     cur_power: statusMap['cur_power'],
            //     powerConsumptionW,
            //     switch_1: statusMap['switch_1'],
            //     deviceInfo_online: deviceOnlineStatus,
            //     active_time: activeTime,
            //     isActuallyOnline,
            //     hasResult: !!response.data.result,
            //     resultLength: response.data.result ? response.data.result.length : 0
            // });
            
            return {
                isOnline: isActuallyOnline,
                responseTimeMs: responseTime,
                powerConsumptionW,
                voltageV,
                error: null,
                deviceId,
                deviceName
            };
        } else {
            // Ошибка в ответе API
            return {
                isOnline: false,
                responseTimeMs: null,
                powerConsumptionW: null,
                voltageV: null,
                error: response.data?.msg || 'Unknown API error',
                deviceId,
                deviceName
            };
        }
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
