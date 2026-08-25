const express = require('express');
const cors = require('cors');
const tuya = require('./tuya');
const db = require('./db');
const ecoflow = require('./ecoflow');
const gridPower = require('./gridPower');
const fcm = require('./fcm');
const notify = require('./notify');

const app = express();
const PORT = process.env.PORT || 8080;

// С 27.01.2025 19:24 (Киев) данные с физической «Розетки 1» пишем в БД как «Обогреватель»
const SOCKET1_HEATER_CUTOFF_UTC = new Date('2026-01-27T17:24:00.000Z'); // 19:24 UTC+2
const SOCKET1_DEVICE_ID = 'bf3c70a960958bcf11ruml';
const HEATER_DEVICE_ID = 'obogrevatel';
const HEATER_DEVICE_NAME = 'Обогреватель';
const KITCHEN_LIGHT_DEVICE_ID = 'bf2a33ded6cd1955cbumtz';
const BOILER_DEVICE_ID = 'bf935c8cff3752fbecgfew';
const PLANT_LIGHT_DEVICE_ID = 'bffd4e253c18de762ct932';
const TH_SENSOR_DEVICE_ID = 'bf2bf2252c37a041b0tbvs';
const SOCKET2_DEVICE_ID = 'bfcbd371e1af7827f9sj79';

const CONTROLLABLE_DEVICE_IDS = new Set([
    SOCKET2_DEVICE_ID,
    HEATER_DEVICE_ID,
    KITCHEN_LIGHT_DEVICE_ID,
    BOILER_DEVICE_ID,
    PLANT_LIGHT_DEVICE_ID,
]);

const CONTROL_ID_MAP = {
    [HEATER_DEVICE_ID]: SOCKET1_DEVICE_ID,
    [SOCKET2_DEVICE_ID]: SOCKET2_DEVICE_ID,
    [KITCHEN_LIGHT_DEVICE_ID]: KITCHEN_LIGHT_DEVICE_ID,
    [BOILER_DEVICE_ID]: BOILER_DEVICE_ID,
    [PLANT_LIGHT_DEVICE_ID]: PLANT_LIGHT_DEVICE_ID,
};

const DEVICE_SORT_ORDER = [
    SOCKET2_DEVICE_ID,
    HEATER_DEVICE_ID,
    'ecoflow',
    KITCHEN_LIGHT_DEVICE_ID,
    BOILER_DEVICE_ID,
    PLANT_LIGHT_DEVICE_ID,
    TH_SENSOR_DEVICE_ID,
];

function sortDevices(devices) {
    return [...devices].sort((a, b) => {
        const ai = DEVICE_SORT_ORDER.indexOf(a.deviceId);
        const bi = DEVICE_SORT_ORDER.indexOf(b.deviceId);
        const aOrder = ai === -1 ? 999 : ai;
        const bOrder = bi === -1 ? 999 : bi;
        return aOrder - bOrder;
    });
}

function mapTuyaResultToDevice(result) {
    const now = new Date();
    let deviceId = result.deviceId;
    let deviceName = result.deviceName;
    if (deviceId === SOCKET1_DEVICE_ID && now >= SOCKET1_HEATER_CUTOFF_UTC) {
        deviceId = HEATER_DEVICE_ID;
        deviceName = HEATER_DEVICE_NAME;
    }
    return {
        deviceId,
        deviceName,
        isOnline: result.isOnline,
        responseTimeMs: result.responseTimeMs ?? null,
        switchOn: result.isOnline ? result.switchOn : null,
        powerConsumptionW: result.isOnline ? result.powerConsumptionW : null,
        voltageV: result.isOnline ? result.voltageV : null,
        ecoflowChargePercent: null,
        powerInputW: null,
        temperatureC: result.isOnline ? result.temperatureC : null,
        humidityPercent: result.isOnline ? result.humidityPercent : null,
        error: result.error ?? null,
    };
}

function mapDbRowToDevice(row) {
    return {
        deviceId: row.device_id,
        deviceName: row.device_name,
        isOnline: row.is_online === 1,
        responseTimeMs: row.response_time_ms,
        switchOn: row.is_online === 1 && row.switch_on != null ? row.switch_on === 1 : null,
        powerConsumptionW: row.power_consumption_w != null ? Number(row.power_consumption_w) : null,
        voltageV: row.voltage_v != null ? Number(row.voltage_v) : null,
        ecoflowChargePercent: row.ecoflow_charge_percent != null ? Number(row.ecoflow_charge_percent) : null,
        powerInputW: null,
        temperatureC: row.temperature_c != null ? Number(row.temperature_c) : null,
        humidityPercent: row.humidity_percent != null ? Number(row.humidity_percent) : null,
        error: row.error_message ?? null,
        recordedAt: row.timestamp,
    };
}

function mapEcoflowToDevice({ chargeLevel, voltageV, consumptionW, inputW }) {
    const hasData = chargeLevel !== null || voltageV !== null || consumptionW !== null || inputW !== null;
    return {
        deviceId: 'ecoflow',
        deviceName: 'Экофлошка',
        isOnline: hasData,
        responseTimeMs: null,
        switchOn: null,
        powerConsumptionW: consumptionW,
        powerInputW: inputW,
        voltageV: voltageV,
        ecoflowChargePercent: chargeLevel,
        temperatureC: null,
        humidityPercent: null,
        error: hasData ? null : 'Не удалось получить данные',
    };
}

// Middleware
app.use(cors()); // Разрешаем CORS для всех запросов
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Логирование всех запросов
app.use((req, res, next) => {
    // console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
});

/**
 * Основной endpoint для Cloud Scheduler
 * Вызывается каждую минуту для проверки доступности розеток
 */
app.post('/monitor', async (req, res) => {
    try {
        console.log('Начало мониторинга розеток...');

        const dbWrites = { ok: 0, fail: 0 };
        async function savePowerStatusTracked(...args) {
            try {
                await db.savePowerStatus(...args);
                dbWrites.ok += 1;
                return true;
            } catch (dbError) {
                dbWrites.fail += 1;
                throw dbError;
            }
        }
        
        // Получаем список устройств
        const devices = tuya.getDevices();
        console.log(`Найдено устройств для мониторинга: ${devices.length}`);
        
        // Получаем заряд, напряжение и потребление экофлошки параллельно с проверкой розеток (один fetch)
        const ecoflowPromise = (async () => {
            try {
                const { chargeLevel, voltageV, consumptionW } = await ecoflow.getEcoFlowVoltageAndConsumption();
                if (chargeLevel !== null || voltageV !== null || consumptionW !== null) {
                    try {
                        await savePowerStatusTracked(
                            'ecoflow',
                            'Экофлошка',
                            true,
                            null,
                            consumptionW,
                            voltageV,
                            chargeLevel,
                            null,
                            null, // temperatureC
                            null, // humidityPercent
                            null  // switchOn
                        );
                        const parts = [];
                        if (chargeLevel !== null) parts.push(`заряд ${chargeLevel.toFixed(1)}%`);
                        if (voltageV !== null) parts.push(`напряжение ${voltageV.toFixed(1)} В`);
                        if (consumptionW !== null) parts.push(`потребление ${consumptionW} Вт`);
                        if (parts.length) console.log(`Экофлошка: ${parts.join(', ')}`);
                    } catch (dbError) {
                        console.error(`Ошибка сохранения данных экофлошки в БД:`, dbError.message);
                    }
                } else {
                    console.log('Экофлошка: не удалось получить данные');
                }
                return chargeLevel;
            } catch (error) {
                console.error('Ошибка получения данных экофлошки:', error.message);
                return null;
            }
        })();
        
        // Проверяем каждое устройство параллельно
        const checkPromises = devices.map(async (device) => {
            try {
                // console.log(`Проверяю устройство: ${device.name} (${device.id})`);
                const result = await tuya.checkDeviceAvailability(device.id, device.name);
                
                // Сохраняем результат в БД (но не прерываем выполнение при ошибке БД)
                try {
                    // Важно: если устройство офлайн, потребление и напряжение должны быть NULL
                    // Даже если API вернул старое значение - не сохраняем его для офлайн устройств
                    const powerConsumptionToSave = result.isOnline ? result.powerConsumptionW : null;
                    const voltageToSave = result.isOnline ? result.voltageV : null;
                    
                    // С 27.01.2025 19:24 данные с «Розетки 1» пишем как «Обогреватель»
                    const now = new Date();
                    const saveDeviceId = (result.deviceId === SOCKET1_DEVICE_ID && now >= SOCKET1_HEATER_CUTOFF_UTC)
                        ? HEATER_DEVICE_ID : result.deviceId;
                    const saveDeviceName = (result.deviceId === SOCKET1_DEVICE_ID && now >= SOCKET1_HEATER_CUTOFF_UTC)
                        ? HEATER_DEVICE_NAME : result.deviceName;
                    
                    const temperatureToSave = result.isOnline && result.temperatureC != null ? result.temperatureC : null;
                    const humidityToSave = result.isOnline && result.humidityPercent != null ? result.humidityPercent : null;
                    const switchToSave = result.isOnline ? result.switchOn : null;
                    await savePowerStatusTracked(
                        saveDeviceId,
                        saveDeviceName,
                        result.isOnline,
                        result.responseTimeMs,
                        powerConsumptionToSave,
                        voltageToSave,
                        null, // ecoflowChargePercent - только для экофлошки
                        result.error,
                        temperatureToSave,
                        humidityToSave,
                        switchToSave
                    );
                } catch (dbError) {
                    // Логируем ошибку БД, но продолжаем с реальными данными устройства
                    console.error(`Ошибка сохранения в БД для ${device.name}:`, dbError.message);
                    // НЕ меняем result.isOnline - оставляем реальное значение от Tuya API
                }
                
                const powerInfo = result.powerConsumptionW !== null ? ` ${result.powerConsumptionW.toFixed(2)}Вт` : '';
                console.log(`${device.name}: ${result.isOnline ? 'Онлайн (свет есть)' : 'Оффлайн (света нет)'}${powerInfo} ${result.responseTimeMs ? `(${result.responseTimeMs}ms)` : ''}`);
                
                return result;
            } catch (error) {
                // Этот catch только для ошибок проверки устройства (Tuya API), не для ошибок БД
                console.error(`Ошибка проверки устройства ${device.name}:`, error.message);
                // При ошибке проверки устройства - считаем его оффлайн
                // Пытаемся сохранить ошибку в БД, но не критично если не получится
                try {
                    const now = new Date();
                    const saveDeviceId = (device.id === SOCKET1_DEVICE_ID && now >= SOCKET1_HEATER_CUTOFF_UTC)
                        ? HEATER_DEVICE_ID : device.id;
                    const saveDeviceName = (device.id === SOCKET1_DEVICE_ID && now >= SOCKET1_HEATER_CUTOFF_UTC)
                        ? HEATER_DEVICE_NAME : device.name;
                    await savePowerStatusTracked(
                        saveDeviceId,
                        saveDeviceName,
                        false,
                        null,
                        null,
                        null,
                        null, // ecoflowChargePercent
                        error.message,
                        null, // temperatureC
                        null, // humidityPercent
                        null  // switchOn
                    );
                } catch (dbError) {
                    console.error(`Не удалось сохранить ошибку в БД: ${dbError.message}`);
                }
                return {
                    deviceId: device.id,
                    deviceName: device.name,
                    isOnline: false,
                    powerConsumptionW: null,
                    error: error.message
                };
            }
        });
        
        // Ждем завершения проверки розеток и получения заряда экофлошки
        const [results, ecoflowCharge] = await Promise.all([
            Promise.all(checkPromises),
            ecoflowPromise
        ]);
        
        // Подсчитываем статистику
        const onlineCount = results.filter(r => r.isOnline).length;
        const offlineCount = results.length - onlineCount;
        const dbAttempts = dbWrites.ok + dbWrites.fail;
        const dbOk = dbAttempts > 0 ? dbWrites.ok > 0 : true;
        
        console.log(`Мониторинг завершен. Онлайн: ${onlineCount}, Оффлайн: ${offlineCount}${ecoflowCharge !== null ? `, Экофло (API): ${ecoflowCharge.toFixed(1)}%` : ''}, dbOk=${dbOk} (ok=${dbWrites.ok}/fail=${dbWrites.fail})`);

        try {
            await notify.recordMonitorDbHealth(dbOk);
        } catch (smsError) {
            console.error('Ошибка SMS DB health notify:', smsError.message);
        }

        try {
            const socketResult = results.find((r) => r.deviceId === SOCKET2_DEVICE_ID);
            const rawPresent = gridPower.computeGridPresent(
                socketResult?.isOnline,
                socketResult?.voltageV
            );
            const gridUpdate = await db.processGridState(rawPresent);
            const pushTimestamp = new Date().toISOString();
            const confirmedPresent = gridUpdate.confirmedPresent;

            if (gridUpdate.shouldNotify && confirmedPresent !== null) {
                await fcm.sendPowerStatusPush({
                    gridPresent: confirmedPresent,
                    chargePercent: ecoflowCharge,
                    timestamp: pushTimestamp,
                    notifyGridChange: true,
                });
                await db.recordWidgetPush(confirmedPresent, ecoflowCharge);
            } else if (confirmedPresent !== null) {
                const chargePush = await db.evaluateChargePush(ecoflowCharge);
                if (chargePush.shouldPush) {
                    await fcm.sendPowerStatusPush({
                        gridPresent: confirmedPresent,
                        chargePercent: ecoflowCharge,
                        timestamp: pushTimestamp,
                        notifyGridChange: false,
                    });
                    await db.recordWidgetPush(confirmedPresent, ecoflowCharge);
                }
            }
        } catch (notifyError) {
            console.error('Ошибка обработки grid state / FCM:', notifyError.message);
        }

        res.json({
            success: true,
            dbOk,
            dbWrites,
            timestamp: new Date().toISOString(),
            devicesChecked: results.length,
            online: onlineCount,
            offline: offlineCount,
            results: results.map(r => ({
                deviceId: r.deviceId,
                deviceName: r.deviceName,
                isOnline: r.isOnline,
                responseTimeMs: r.responseTimeMs,
                powerConsumptionW: r.powerConsumptionW
            })),
            ecoflowCharge: ecoflowCharge
        });
    } catch (error) {
        console.error('Критическая ошибка мониторинга:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * GET endpoint — live-снимок всех устройств (без записи в БД)
 */
app.get('/monitor', async (req, res) => {
    try {
        const devices = tuya.getDevices();
        const [results, ecoflowData] = await Promise.all([
            Promise.all(devices.map(device => tuya.checkDeviceAvailability(device.id, device.name))),
            ecoflow.getEcoFlowVoltageAndConsumption(),
        ]);

        const deviceList = sortDevices([
            ...results.map(mapTuyaResultToDevice),
            mapEcoflowToDevice(ecoflowData),
        ]);

        res.json({
            success: true,
            source: 'live',
            timestamp: new Date().toISOString(),
            devices: deviceList,
        });
    } catch (error) {
        console.error('Ошибка live-проверки устройств:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

const CONTROL_VERIFY_ATTEMPTS = 4;
const CONTROL_VERIFY_DELAY_MS = 1500;

function getTuyaDeviceLabel(tuyaDeviceId) {
    const found = tuya.getDevices().find((device) => device.id === tuyaDeviceId);
    return found?.name ?? tuyaDeviceId;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * После команды опрашивает Tuya, пока реле не совпадёт с ожиданием или не исчерпаны попытки.
 * @returns {Promise<{ verified: boolean, offline: boolean, result: object }>}
 */
async function verifySwitchAfterCommand(tuyaDeviceId, deviceName, expectedOn) {
    let lastResult = null;

    for (let attempt = 0; attempt < CONTROL_VERIFY_ATTEMPTS; attempt++) {
        if (attempt > 0) {
            await sleep(CONTROL_VERIFY_DELAY_MS);
        }
        const result = await tuya.checkDeviceAvailability(tuyaDeviceId, deviceName);
        lastResult = result;

        if (!result.isOnline) {
            continue;
        }
        if (result.switchOn === expectedOn) {
            return { verified: true, offline: false, result };
        }
    }

    if (!lastResult || !lastResult.isOnline) {
        return { verified: false, offline: true, result: lastResult };
    }
    if (lastResult.switchOn === expectedOn) {
        return { verified: true, offline: false, result: lastResult };
    }
    return { verified: false, offline: false, result: lastResult };
}

/**
 * POST /api/control — вкл/выкл розетки или света
 * Body: { deviceId: string, on: boolean }
 */
app.post('/api/control', async (req, res) => {
    try {
        const { deviceId, on } = req.body || {};

        if (!deviceId || typeof on !== 'boolean') {
            return res.status(400).json({
                success: false,
                error: 'Требуются deviceId (string) и on (boolean)',
            });
        }

        if (!CONTROLLABLE_DEVICE_IDS.has(deviceId)) {
            return res.status(400).json({
                success: false,
                error: `Устройство ${deviceId} не поддерживает управление`,
            });
        }

        const tuyaDeviceId = CONTROL_ID_MAP[deviceId];
        const deviceName = getTuyaDeviceLabel(tuyaDeviceId);
        await tuya.sendDeviceCommand(tuyaDeviceId, { code: 'switch_1', value: on });

        const verification = await verifySwitchAfterCommand(tuyaDeviceId, deviceName, on);
        if (!verification.verified) {
            const actual = verification.result;
            if (verification.offline) {
                return res.json({
                    success: false,
                    verified: false,
                    deviceId,
                    isOnline: false,
                    switchOn: null,
                    error: 'Устройство офлайн — не удалось подтвердить переключение',
                });
            }
            return res.json({
                success: false,
                verified: false,
                deviceId,
                isOnline: actual?.isOnline ?? false,
                switchOn: actual?.switchOn ?? null,
                error: 'Состояние устройства не изменилось',
            });
        }

        res.json({
            success: true,
            verified: true,
            deviceId,
            isOnline: verification.result.isOnline,
            switchOn: verification.result.switchOn,
        });
    } catch (error) {
        console.error('Ошибка управления устройством:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * GET /api/current — последний снимок из БД (быстрый, ~1 мин свежести)
 */
app.get('/api/current', async (req, res) => {
    try {
        const rows = await db.getCurrentStatus();
        const devices = sortDevices(rows.map(mapDbRowToDevice));
        const latestTimestamp = rows.reduce((latest, row) => {
            const ts = new Date(row.timestamp).getTime();
            return ts > latest ? ts : latest;
        }, 0);

        res.json({
            success: true,
            source: 'database',
            timestamp: latestTimestamp ? new Date(latestTimestamp).toISOString() : new Date().toISOString(),
            devices,
        });
    } catch (error) {
        console.error('Ошибка получения текущего статуса из БД:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * POST /api/fcm/register — регистрация FCM-токена Android-приложения
 */
app.post('/api/fcm/register', async (req, res) => {
    try {
        const token = req.body && req.body.token;
        if (!token || typeof token !== 'string' || token.length < 10) {
            return res.status(400).json({ success: false, error: 'token required' });
        }
        await db.upsertFcmToken(token.trim(), req.body.platform || 'android');
        res.json({ success: true });
    } catch (error) {
        console.error('Ошибка регистрации FCM token:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/fcm/unregister — удаление FCM-токена
 */
app.post('/api/fcm/unregister', async (req, res) => {
    try {
        const token = req.body && req.body.token;
        if (!token || typeof token !== 'string') {
            return res.status(400).json({ success: false, error: 'token required' });
        }
        await db.removeFcmToken(token.trim());
        res.json({ success: true });
    } catch (error) {
        console.error('Ошибка удаления FCM token:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/widget — лёгкий снимок для виджета (сеть + заряд)
 */
app.get('/api/widget', async (req, res) => {
    try {
        const snapshot = await db.getLatestWidgetSnapshot(
            gridPower.SOCKET2_DEVICE_ID,
            gridPower.ECOFLOW_DEVICE_ID,
            gridPower.computeGridPresent
        );
        res.json({
            success: true,
            ...snapshot,
        });
    } catch (error) {
        console.error('Ошибка получения widget snapshot:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * API endpoint для получения статистики
 * GET /api/stats?deviceId=xxx&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 */
app.get('/api/stats', async (req, res) => {
    try {
        const { deviceId, startDate, endDate } = req.query;
        
        const stats = await db.getStats(deviceId || null, startDate || null, endDate || null);
        
        res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        console.error('Ошибка получения статистики:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * API endpoint для получения данных для графика по дням
 * GET /api/daily?deviceId=xxx&days=30
 * GET /api/daily?deviceId=xxx&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 */
app.get('/api/daily', async (req, res) => {
    try {
        const deviceId = req.query.deviceId || null;
        const { days, startDate, endDate } = req.query;
        
        let chartData;
        
        // Если указаны startDate и endDate - используем их
        if (startDate && endDate) {
            chartData = await db.getStats(deviceId, startDate, endDate);
        } else {
            // Иначе используем days
            const daysNum = days ? parseInt(days, 10) : 30;
            chartData = await db.getDailyChart(deviceId, daysNum);
        }
        
        res.json({
            success: true,
            data: chartData
        });
    } catch (error) {
        console.error('Ошибка получения данных графика:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * API endpoint для получения детальных данных за день
 * GET /api/daily-details?deviceId=xxx&date=YYYY-MM-DD
 */
app.get('/api/daily-details', async (req, res) => {
    try {
        const { deviceId, date } = req.query;
        
        if (!deviceId || !date) {
            return res.status(400).json({
                success: false,
                error: 'Требуются параметры deviceId и date (YYYY-MM-DD)'
            });
        }
        
        const details = await db.getDailyDetails(deviceId, date);
        
        res.json({
            success: true,
            data: details
        });
    } catch (error) {
        console.error('Ошибка получения детальных данных:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * API endpoint для получения общей статистики
 * GET /api/overall?deviceId=xxx&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 */
app.get('/api/overall', async (req, res) => {
    try {
        const { deviceId, startDate, endDate } = req.query;
        
        const stats = await db.getOverallStats(deviceId || null, startDate || null, endDate || null);
        
        res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        console.error('Ошибка получения общей статистики:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * API endpoint для получения суммарного потребления за день
 * GET /api/daily-power?deviceId=xxx&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&days=30
 */
app.get('/api/daily-power', async (req, res) => {
    try {
        const { deviceId, startDate, endDate, days } = req.query;
        
        // Если указан days - используем его, иначе startDate/endDate
        // Даты формируются в локальном времени (сервер Cloud Run должен быть в UTC, но MySQL конвертирует в UTC+2)
        let dailyPower;
        if (days) {
            const daysNum = parseInt(days, 10);
            // Используем UTC время, но MySQL конвертирует его в UTC+2 при выборке
            const now = new Date();
            const endDateStr = now.toISOString().split('T')[0];
            const startDateObj = new Date(now);
            startDateObj.setDate(startDateObj.getDate() - daysNum);
            const startDateStr = startDateObj.toISOString().split('T')[0];
            dailyPower = await db.getDailyPowerConsumption(deviceId || null, startDateStr, endDateStr);
        } else {
            dailyPower = await db.getDailyPowerConsumption(deviceId || null, startDate || null, endDate || null);
        }
        
        res.json({
            success: true,
            data: dailyPower
        });
    } catch (error) {
        console.error('Ошибка получения суммарного потребления:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * API endpoint для получения детальных данных о потреблении за день (для графика)
 * GET /api/power-details?deviceId=xxx&date=YYYY-MM-DD
 */
app.get('/api/power-details', async (req, res) => {
    try {
        const { deviceId, date } = req.query;
        
        if (!deviceId || !date) {
            return res.status(400).json({
                success: false,
                error: 'Требуются параметры deviceId и date (YYYY-MM-DD)'
            });
        }
        
        const details = await db.getDailyPowerDetails(deviceId, date);
        
        res.json({
            success: true,
            data: details
        });
    } catch (error) {
        console.error('Ошибка получения детальных данных о потреблении:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * API endpoint для получения почасовых данных за период (для графика)
 * GET /api/hourly?deviceId=xxx&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 */
app.get('/api/hourly', async (req, res) => {
    try {
        const { deviceId, startDate, endDate } = req.query;
        
        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                error: 'Требуются параметры startDate и endDate (YYYY-MM-DD)'
            });
        }
        
        const hourlyData = await db.getHourlyData(deviceId || null, startDate, endDate);
        
        res.json({
            success: true,
            data: hourlyData
        });
    } catch (error) {
        console.error('Ошибка получения почасовых данных:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * API endpoint для получения данных агрегированных по 10 минут за период (для графика)
 * GET /api/ten-minute?deviceId=xxx&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 */
app.get('/api/ten-minute', async (req, res) => {
    try {
        const { deviceId, startDate, endDate } = req.query;
        
        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                error: 'Требуются параметры startDate и endDate (YYYY-MM-DD)'
            });
        }
        
        const tenMinuteData = await db.getTenMinuteData(deviceId || null, startDate, endDate);
        
        res.json({
            success: true,
            data: tenMinuteData
        });
    } catch (error) {
        console.error('Ошибка получения данных по 10 минут:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * API endpoint для получения поминутных данных за период (для графика)
 * GET /api/minute?deviceId=xxx&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 */
app.get('/api/minute', async (req, res) => {
    try {
        const { deviceId, startDate, endDate } = req.query;
        
        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                error: 'Требуются параметры startDate и endDate (YYYY-MM-DD)'
            });
        }
        
        const minuteData = await db.getMinuteData(deviceId || null, startDate, endDate);
        
        res.json({
            success: true,
            data: minuteData
        });
    } catch (error) {
        console.error('Ошибка получения поминутных данных:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Health check endpoint
 */
app.get('/health', async (req, res) => {
    try {
        const dbConnected = await db.testConnection();
        
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            database: dbConnected ? 'connected' : 'disconnected'
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.message
        });
    }
});

/**
 * Root endpoint - информация о сервисе
 */
app.get('/', (req, res) => {
    res.json({
        service: 'Tuya Power Monitor',
        version: '1.0.0',
        endpoints: {
            monitor: 'POST /monitor - Проверка и запись в БД (Cloud Scheduler)',
            monitorLive: 'GET /monitor - Live-снимок всех устройств (без записи в БД)',
            current: 'GET /api/current - Последний снимок из БД',
            widget: 'GET /api/widget - Сеть + заряд для виджета',
            fcmRegister: 'POST /api/fcm/register - Регистрация FCM-токена',
            fcmUnregister: 'POST /api/fcm/unregister - Удаление FCM-токена',
            control: 'POST /api/control - Вкл/выкл розетки или света',
            stats: 'GET /api/stats - Статистика за период',
            daily: 'GET /api/daily - Данные для графика по дням',
            dailyDetails: 'GET /api/daily-details - Детальные данные за день',
            overall: 'GET /api/overall - Общая статистика',
            powerConsumption: 'GET /api/power-consumption - Данные о потреблении за период',
            dailyPower: 'GET /api/daily-power - Суммарное потребление за день',
            powerDetails: 'GET /api/power-details - Детальные данные о потреблении за день',
            hourly: 'GET /api/hourly - Почасовые данные за период',
            minute: 'GET /api/minute - Поминутные данные за период',
            health: 'GET /health - Проверка состояния сервиса'
        }
    });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('Получен SIGTERM, закрываю подключения...');
    await db.closePool();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('Получен SIGINT, закрываю подключения...');
    await db.closePool();
    process.exit(0);
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`Сервис мониторинга запущен на порту ${PORT}`);
    console.log(`Окружение: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
