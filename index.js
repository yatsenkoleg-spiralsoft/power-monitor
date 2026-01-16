const express = require('express');
const cors = require('cors');
const tuya = require('./tuya');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors()); // Разрешаем CORS для всех запросов
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Логирование всех запросов
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
});

/**
 * Основной endpoint для Cloud Scheduler
 * Вызывается каждую минуту для проверки доступности розеток
 */
app.post('/monitor', async (req, res) => {
    try {
        console.log('Начало мониторинга розеток...');
        
        // Получаем список устройств
        const devices = tuya.getDevices();
        console.log(`Найдено устройств для мониторинга: ${devices.length}`);
        
        // Проверяем каждое устройство параллельно
        const checkPromises = devices.map(async (device) => {
            try {
                console.log(`Проверяю устройство: ${device.name} (${device.id})`);
                const result = await tuya.checkDeviceAvailability(device.id, device.name);
                
                // Сохраняем результат в БД (но не прерываем выполнение при ошибке БД)
                try {
                    // Важно: если устройство офлайн, потребление должно быть NULL
                    // Даже если API вернул старое значение - не сохраняем его для офлайн устройств
                    const powerConsumptionToSave = result.isOnline ? result.powerConsumptionW : null;
                    
                    await db.savePowerStatus(
                        result.deviceId,
                        result.deviceName,
                        result.isOnline,
                        result.responseTimeMs,
                        powerConsumptionToSave,
                        result.error
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
                    await db.savePowerStatus(
                        device.id,
                        device.name,
                        false,
                        null,
                        null,
                        error.message
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
        
        const results = await Promise.all(checkPromises);
        
        // Подсчитываем статистику
        const onlineCount = results.filter(r => r.isOnline).length;
        const offlineCount = results.length - onlineCount;
        
        console.log(`Мониторинг завершен. Онлайн: ${onlineCount}, Оффлайн: ${offlineCount}`);
        
        res.json({
            success: true,
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
            }))
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
 * GET endpoint для ручной проверки (для тестирования)
 */
app.get('/monitor', async (req, res) => {
    try {
        console.log('Ручная проверка устройств...');
        
        const devices = tuya.getDevices();
        const results = await Promise.all(
            devices.map(device => tuya.checkDeviceAvailability(device.id, device.name))
        );
        
        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            results
        });
    } catch (error) {
        console.error('Ошибка ручной проверки:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
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
            monitor: 'POST /monitor - Проверка доступности розеток (для Cloud Scheduler)',
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
