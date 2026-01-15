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
async function getAccessToken() {
    if (accessToken) return accessToken;
    
    console.log("Запрашиваю новый токен доступа Tuya...");
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
            console.log('Токен Tuya успешно получен');
            return accessToken;
        }
        throw new Error(response.data.msg || 'Unknown error');
    } catch (error) {
        console.error('Ошибка получения токена Tuya:', error.message);
        throw new Error(`Не удалось получить токен доступа: ${error.message}`);
    }
}

/**
 * Проверяет доступность устройства через Tuya API
 * Возвращает объект с информацией о статусе
 */
async function checkDeviceAvailability(deviceId, deviceName = null) {
    const startTime = Date.now();
    
    try {
        const token = await getAccessToken();
        const path = `/v1.0/devices/${deviceId}/status`;
        const { t, sign } = signRequest(path, 'GET', {}, {}, token);
        
        const headers = {
            'client_id': ACCESS_ID,
            'access_token': token,
            'sign': sign,
            't': t,
            'sign_method': 'HMAC-SHA256'
        };
        
        const response = await axios.get(`${API_BASE_URL}${path}`, {
            headers,
            timeout: 15000 // 15 секунд таймаут для проверки
        });
        
        const responseTime = Date.now() - startTime;
        
        if (response.data && response.data.success) {
            // Устройство доступно - значит свет есть
            // Извлекаем данные о потреблении
            const statusMap = response.data.result.reduce((acc, { code, value }) => {
                acc[code] = value;
                return acc;
            }, {});
            
            // Получаем потребление (cur_power приходит в десятых долях ватта, делим на 10)
            const powerValue = statusMap['cur_power'] || null;
            const powerConsumptionW = powerValue !== null ? powerValue / 10 : null;
            
            return {
                isOnline: true,
                responseTimeMs: responseTime,
                powerConsumptionW,
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
}

module.exports = {
    checkDeviceAvailability,
    getDevices,
    resetToken,
    DEVICE_IDS
};
