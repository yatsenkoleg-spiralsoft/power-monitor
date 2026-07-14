#!/usr/bin/env node
/**
 * Выполняет запросы к Tuya API и выводит ответы в консоль (токен, device info, status, iot-03/status).
 * Запуск: TUYA_ACCESS_ID=xxx TUYA_ACCESS_KEY=yyy node print-curl.js
 * или: npm run curl-debug (если заданы в .env)
 */
const crypto = require('crypto');
const axios = require('axios');

try {
    require('dotenv').config();
} catch (e) {}

const ACCESS_ID = process.env.TUYA_ACCESS_ID || 'ngmx5g335f775jqnhe43';
const ACCESS_KEY = process.env.TUYA_ACCESS_KEY || 'd6489608a69f46beb29910c39931346e';
const API_BASE_URL = process.env.TUYA_API_URL || 'https://openapi.tuyaeu.com';
const DEVICE_ID = process.env.TUYA_DEBUG_DEVICE_ID || 'bf2bf2252c37a041b0tbvs';

if (!ACCESS_ID || !ACCESS_KEY) {
    console.error('Задайте TUYA_ACCESS_ID и TUYA_ACCESS_KEY (или скопируйте .env из ENV.example).');
    process.exit(1);
}

function signRequest(path, method, query, body, token) {
    const t = Date.now().toString();
    const bodyStr = (method === 'POST' || method === 'PUT') ? JSON.stringify(body) : '';
    const contentHash = crypto.createHash('sha256').update(bodyStr).digest('hex').toLowerCase();
    const querySorted = Object.entries(query).sort().map(v => v.join('=')).join('&');
    const urlForSign = querySorted ? `${path}?${querySorted}` : path;
    const stringToSign = `${method}\n${contentHash}\n\n${urlForSign}`;
    const signStr = `${ACCESS_ID}${token || ''}${t}${stringToSign}`;
    const sign = crypto.createHmac('sha256', ACCESS_KEY).update(signStr).digest('hex').toUpperCase();
    return { t, sign };
}

async function get(path, query, token) {
    const q = query || {};
    const { t, sign } = signRequest(path, 'GET', q, {}, token);
    const url = q && Object.keys(q).length ? `${API_BASE_URL}${path}?${new URLSearchParams(q)}` : `${API_BASE_URL}${path}`;
    const res = await axios.get(url, {
        headers: {
            client_id: ACCESS_ID,
            access_token: token,
            sign,
            t,
            sign_method: 'HMAC-SHA256',
            'Cache-Control': 'no-cache, no-store',
            'Pragma': 'no-cache'
        },
        timeout: 15000
    });
    return res.data;
}

async function main() {
    console.log('=== 1. Получение токена ===\n');
    const pathToken = '/v1.0/token';
    const queryToken = { grant_type: 1 };
    const { t: t0, sign: sign0 } = signRequest(pathToken, 'GET', queryToken, {}, null);
    const urlToken = `${API_BASE_URL}${pathToken}?grant_type=1`;
    const resToken = await axios.get(urlToken, {
        headers: { client_id: ACCESS_ID, sign: sign0, t: t0, sign_method: 'HMAC-SHA256' },
        timeout: 10000
    });
    console.log(JSON.stringify(resToken.data, null, 2));
    if (!resToken.data || !resToken.data.success) {
        console.error('Ошибка получения токена.');
        process.exit(1);
    }
    const token = resToken.data.result.access_token;
    console.log('\n');

    console.log('=== 2. Device info (GET /v1.0/devices/' + DEVICE_ID + ') ===\n');
    try {
        const dataInfo = await get(`/v1.0/devices/${DEVICE_ID}`, {}, token);
        console.log(JSON.stringify(dataInfo, null, 2));
    } catch (e) {
        console.log(e.response?.data ? JSON.stringify(e.response.data, null, 2) : e.message);
    }
    console.log('\n');

    console.log('=== 3. Status (GET /v1.0/devices/' + DEVICE_ID + '/status) ===\n');
    try {
        const dataStatus = await get(`/v1.0/devices/${DEVICE_ID}/status`, {}, token);
        console.log(JSON.stringify(dataStatus, null, 2));
    } catch (e) {
        console.log(e.response?.data ? JSON.stringify(e.response.data, null, 2) : e.message);
    }
    console.log('\n');

    console.log('=== 4. Status IoT-03 (GET /v1.0/iot-03/devices/' + DEVICE_ID + '/status) ===\n');
    try {
        const dataIot03 = await get(`/v1.0/iot-03/devices/${DEVICE_ID}/status`, {}, token);
        console.log(JSON.stringify(dataIot03, null, 2));
    } catch (e) {
        console.log(e.response?.data ? JSON.stringify(e.response.data, null, 2) : e.message);
    }
    console.log('\n');

    // Query Properties (v2.0) — свойства, отчитанные устройством в облако (температура/влажность по Zigbee DP1/DP2)
    // Документация: https://developer.tuya.com/en/docs/cloud/116cc8bf6f?id=Kcp2kwfrpe719
    console.log('=== 5. Query Properties (GET /v2.0/cloud/thing/' + DEVICE_ID + '/shadow/properties) ===\n');
    let gotProperties = false;
    try {
        const pathShadow = `/v2.0/cloud/thing/${DEVICE_ID}/shadow/properties`;
        let dataShadow = await get(pathShadow, { codes: '1,2' }, token);
        console.log('С параметром codes=1,2:', JSON.stringify(dataShadow, null, 2));
        const props = dataShadow && dataShadow.result && dataShadow.result.properties ? dataShadow.result.properties : (dataShadow && dataShadow.result && Array.isArray(dataShadow.result) ? dataShadow.result : null);
        if (props && props.length > 0) {
            gotProperties = true;
            const temp = props.find(p => (p.code === '1' || p.code === 1 || p.code === 'va_temperature' || p.code === 'temperature'));
            const hum = props.find(p => (p.code === '2' || p.code === 2 || p.code === 'va_humidity' || p.code === 'humidity'));
            console.log('\n--- Извлечённые значения ---');
            if (temp) console.log('Температура:', temp.value, '(code: ' + temp.code + ')');
            if (hum) console.log('Влажность:', hum.value, '(code: ' + hum.code + ')');
        }
        if (!gotProperties && (!dataShadow.result || Object.keys(dataShadow.result).length === 0)) {
            console.log('\nПробуем без параметра codes (все свойства):');
            dataShadow = await get(pathShadow, {}, token);
            console.log(JSON.stringify(dataShadow, null, 2));
            const propsAll = dataShadow && dataShadow.result && (dataShadow.result.properties || dataShadow.result);
            const list = Array.isArray(propsAll) ? propsAll : (propsAll && typeof propsAll === 'object' ? Object.entries(propsAll).map(([k, v]) => ({ code: k, value: v })) : []);
            if (list.length > 0) {
                gotProperties = true;
                console.log('\n--- Все свойства ---');
                list.forEach(p => console.log(p.code + ':', p.value));
            }
        }
        if (!gotProperties) {
            console.log('\n(Облако Tuya не возвращает свойства для этого устройства по данным API — temperature/humidity недоступны.)');
        }
    } catch (e) {
        console.log(e.response?.data ? JSON.stringify(e.response.data, null, 2) : e.message);
    }
}

main().catch(err => {
    console.error(err.message || err);
    process.exit(1);
});
