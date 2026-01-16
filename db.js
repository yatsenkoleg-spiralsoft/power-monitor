const mysql = require('mysql2/promise');

// Конфигурация подключения к MySQL из переменных окружения (обязательные параметры)
const dbConfig = {
    host: process.env.MYSQL_HOST,
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    database: process.env.MYSQL_DATABASE,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
};

// Проверка обязательных переменных окружения
if (!dbConfig.host || !dbConfig.database || !dbConfig.user || !dbConfig.password) {
    throw new Error('Требуются переменные окружения: MYSQL_HOST, MYSQL_DATABASE, MYSQL_USER, MYSQL_PASSWORD');
}

// Создаем пул подключений
let pool = null;

/**
 * Получает или создает пул подключений к MySQL
 */
function getPool() {
    if (!pool) {
        pool = mysql.createPool(dbConfig);
        console.log('Пул подключений к MySQL создан');
    }
    return pool;
}

/**
 * Закрывает пул подключений (для graceful shutdown)
 */
async function closePool() {
    if (pool) {
        await pool.end();
        pool = null;
        console.log('Пул подключений к MySQL закрыт');
    }
}

/**
 * Записывает результат проверки устройства в базу данных
 */
async function savePowerStatus(deviceId, deviceName, isOnline, responseTimeMs = null, powerConsumptionW = null, errorMessage = null) {
    const pool = getPool();
    
    try {
        const query = `
            INSERT INTO power_status 
            (timestamp, device_id, device_name, is_online, response_time_ms, power_consumption_w, error_message)
            VALUES (NOW(), ?, ?, ?, ?, ?, ?)
        `;
        
        const [result] = await pool.execute(query, [
            deviceId,
            deviceName,
            isOnline ? 1 : 0,
            responseTimeMs,
            powerConsumptionW,
            errorMessage
        ]);
        
        return result.insertId;
    } catch (error) {
        console.error('Ошибка записи в power_status:', error.message);
        throw error;
    }
}

/**
 * Получает статистику за период
 */
async function getStats(deviceId = null, startDate = null, endDate = null) {
    const pool = getPool();
    
    try {
        let query = `
            SELECT 
                DATE(CONVERT_TZ(timestamp, '+00:00', '+02:00')) as date,
                device_id,
                device_name,
                COUNT(*) as total_checks,
                SUM(is_online) as minutes_online,
                COUNT(*) - SUM(is_online) as minutes_offline,
                AVG(CASE WHEN response_time_ms IS NOT NULL THEN response_time_ms END) as avg_response_time_ms,
                AVG(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w END) as avg_power_w,
                SUM(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w * (1.0 / 60.0) ELSE 0 END) as total_consumption_kwh
            FROM power_status
            WHERE 1=1
        `;
        
        const params = [];
        
        if (deviceId) {
            query += ' AND device_id = ?';
            params.push(deviceId);
        }
        
        if (startDate) {
            query += ' AND DATE(CONVERT_TZ(timestamp, \'+00:00\', \'+02:00\')) >= ?';
            params.push(startDate);
        }
        
        if (endDate) {
            query += ' AND DATE(CONVERT_TZ(timestamp, \'+00:00\', \'+02:00\')) <= ?';
            params.push(endDate);
        }
        
        query += ' GROUP BY DATE(CONVERT_TZ(timestamp, \'+00:00\', \'+02:00\')), device_id, device_name ORDER BY date DESC, device_id';
        
        const [rows] = await pool.execute(query, params);
        return rows;
    } catch (error) {
        console.error('Ошибка получения статистики:', error.message);
        throw error;
    }
}

/**
 * Получает детальные данные за день (по часам)
 */
async function getDailyDetails(deviceId, date) {
    const pool = getPool();
    
    try {
        const query = `
            SELECT 
                DATE_FORMAT(CONVERT_TZ(timestamp, '+00:00', '+02:00'), '%Y-%m-%d %H:%i') as time,
                timestamp,
                is_online,
                response_time_ms,
                power_consumption_w,
                error_message
            FROM power_status
            WHERE device_id = ? AND DATE(CONVERT_TZ(timestamp, '+00:00', '+02:00')) = ?
            ORDER BY CONVERT_TZ(timestamp, '+00:00', '+02:00') ASC
        `;
        
        const [rows] = await pool.execute(query, [deviceId, date]);
        return rows;
    } catch (error) {
        console.error('Ошибка получения детальных данных:', error.message);
        throw error;
    }
}

/**
 * Получает данные для графика по дням
 */
async function getDailyChart(deviceId = null, days = 30) {
    const pool = getPool();
    
    try {
        let query, params;
        
        // Если days = 0 - запрашиваем только сегодня
        if (days === 0) {
            query = `
                SELECT 
                    DATE(CONVERT_TZ(timestamp, '+00:00', '+02:00')) as date,
                    device_id,
                    device_name,
                    COUNT(*) as total_checks,
                    SUM(is_online) as minutes_online,
                    COUNT(*) - SUM(is_online) as minutes_offline,
                    ROUND((SUM(is_online) / COUNT(*)) * 100, 2) as availability_percent,
                    AVG(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w END) as avg_power_w,
                    SUM(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w * (1.0 / 60.0) ELSE 0 END) as total_consumption_kwh
                FROM power_status
                WHERE DATE(CONVERT_TZ(timestamp, '+00:00', '+02:00')) = CURDATE()
                ${deviceId ? 'AND device_id = ?' : ''}
                GROUP BY DATE(CONVERT_TZ(timestamp, '+00:00', '+02:00')), device_id, device_name
                ORDER BY date DESC, device_id
            `;
            
            params = deviceId ? [deviceId] : [];
        } else {
            query = `
                SELECT 
                    DATE(CONVERT_TZ(timestamp, '+00:00', '+02:00')) as date,
                    device_id,
                    device_name,
                    COUNT(*) as total_checks,
                    SUM(is_online) as minutes_online,
                    COUNT(*) - SUM(is_online) as minutes_offline,
                    ROUND((SUM(is_online) / COUNT(*)) * 100, 2) as availability_percent,
                    AVG(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w END) as avg_power_w,
                    SUM(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w * (1.0 / 60.0) ELSE 0 END) as total_consumption_kwh
                FROM power_status
                WHERE CONVERT_TZ(timestamp, '+00:00', '+02:00') >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
                ${deviceId ? 'AND device_id = ?' : ''}
                GROUP BY DATE(CONVERT_TZ(timestamp, '+00:00', '+02:00')), device_id, device_name
                ORDER BY date DESC, device_id
            `;
            
            params = [days];
            if (deviceId) {
                params.push(deviceId);
            }
        }
        
        const [rows] = await pool.execute(query, params);
        return rows;
    } catch (error) {
        console.error('Ошибка получения данных для графика:', error.message);
        throw error;
    }
}

/**
 * Получает общую статистику (за все время или за период)
 */
async function getOverallStats(deviceId = null, startDate = null, endDate = null) {
    const pool = getPool();
    
    try {
        let query = `
            SELECT 
                device_id,
                device_name,
                COUNT(*) as total_checks,
                SUM(is_online) as total_minutes_online,
                COUNT(*) - SUM(is_online) as total_minutes_offline,
                ROUND((SUM(is_online) / COUNT(*)) * 100, 2) as availability_percent,
                ROUND(SUM(is_online) / 60.0, 2) as hours_online,
                ROUND((COUNT(*) - SUM(is_online)) / 60.0, 2) as hours_offline,
                AVG(CASE WHEN response_time_ms IS NOT NULL THEN response_time_ms END) as avg_response_time_ms,
                AVG(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w END) as avg_power_w,
                SUM(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w * (1.0 / 60.0) ELSE 0 END) as total_consumption_kwh
            FROM power_status
            WHERE 1=1
        `;
        
        const params = [];
        
        if (deviceId) {
            query += ' AND device_id = ?';
            params.push(deviceId);
        }
        
        if (startDate) {
            query += ' AND DATE(CONVERT_TZ(timestamp, \'+00:00\', \'+02:00\')) >= ?';
            params.push(startDate);
        }
        
        if (endDate) {
            query += ' AND DATE(CONVERT_TZ(timestamp, \'+00:00\', \'+02:00\')) <= ?';
            params.push(endDate);
        }
        
        query += ' GROUP BY device_id, device_name ORDER BY device_id';
        
        const [rows] = await pool.execute(query, params);
        return rows;
    } catch (error) {
        console.error('Ошибка получения общей статистики:', error.message);
        throw error;
    }
}

/**
 * Получает суммарное потребление за день (кВт*ч)
 * Формула: сумма (power_consumption_w * (1/60) часа) для каждой минуты с данными
 */
async function getDailyPowerConsumption(deviceId = null, startDate = null, endDate = null) {
    const pool = getPool();
    
    try {
        let query = `
            SELECT 
                DATE(CONVERT_TZ(timestamp, '+00:00', '+02:00')) as date,
                device_id,
                device_name,
                COUNT(CASE WHEN power_consumption_w IS NOT NULL THEN 1 END) as readings_count,
                AVG(power_consumption_w) as avg_power_w,
                -- Сумма: каждая минута с потреблением = power_w * (1/60) часа = кВт*ч
                SUM(power_consumption_w * (1.0 / 60.0)) as total_consumption_kwh
            FROM power_status
            WHERE is_online = 1 AND power_consumption_w IS NOT NULL
        `;
        
        const params = [];
        
        if (deviceId) {
            query += ' AND device_id = ?';
            params.push(deviceId);
        }
        
        if (startDate) {
            query += ' AND DATE(CONVERT_TZ(timestamp, \'+00:00\', \'+02:00\')) >= ?';
            params.push(startDate);
        }
        
        if (endDate) {
            query += ' AND DATE(CONVERT_TZ(timestamp, \'+00:00\', \'+02:00\')) <= ?';
            params.push(endDate);
        }
        
        query += ' GROUP BY DATE(CONVERT_TZ(timestamp, \'+00:00\', \'+02:00\')), device_id, device_name ORDER BY date DESC, device_id';
        
        const [rows] = await pool.execute(query, params);
        return rows;
    } catch (error) {
        console.error('Ошибка получения суммарного потребления:', error.message);
        throw error;
    }
}

/**
 * Получает детальные данные о потреблении за день (для графика)
 */
async function getDailyPowerDetails(deviceId, date) {
    const pool = getPool();
    
    try {
        const query = `
            SELECT 
                DATE_FORMAT(CONVERT_TZ(timestamp, '+00:00', '+02:00'), '%Y-%m-%d %H:%i') as time,
                timestamp,
                power_consumption_w,
                is_online
            FROM power_status
            WHERE device_id = ? AND DATE(CONVERT_TZ(timestamp, '+00:00', '+02:00')) = ?
            ORDER BY CONVERT_TZ(timestamp, '+00:00', '+02:00') ASC
        `;
        
        const [rows] = await pool.execute(query, [deviceId, date]);
        return rows;
    } catch (error) {
        console.error('Ошибка получения детальных данных о потреблении:', error.message);
        throw error;
    }
}

/**
 * Получает почасовые данные за период (для графика)
 */
async function getHourlyData(deviceId = null, startDate = null, endDate = null) {
    const pool = getPool();
    
    try {
        let query = `
            SELECT 
                DATE_FORMAT(CONVERT_TZ(timestamp, '+00:00', '+02:00'), '%Y-%m-%d %H:00') as hour,
                DATE(CONVERT_TZ(timestamp, '+00:00', '+02:00')) as date,
                HOUR(CONVERT_TZ(timestamp, '+00:00', '+02:00')) as hour_num,
                device_id,
                device_name,
                COUNT(*) as total_checks,
                SUM(is_online) as minutes_online,
                COUNT(*) - SUM(is_online) as minutes_offline,
                ROUND((SUM(is_online) / COUNT(*)) * 100, 2) as availability_percent,
                AVG(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w END) as avg_power_w,
                -- Для агрегированных данных: средняя мощность * количество минут онлайн / 60
                COALESCE(AVG(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w END) * (SUM(is_online) / 60.0), 0) as total_consumption_kwh
            FROM power_status
            WHERE 1=1
        `;
        
        const params = [];
        
        if (deviceId) {
            query += ' AND device_id = ?';
            params.push(deviceId);
        }
        
        if (startDate) {
            query += ' AND DATE(timestamp) >= ?';
            params.push(startDate);
        }
        
        if (endDate) {
            query += ' AND DATE(timestamp) <= ?';
            params.push(endDate);
        }
        
        query += ' GROUP BY DATE(CONVERT_TZ(timestamp, \'+00:00\', \'+02:00\')), HOUR(CONVERT_TZ(timestamp, \'+00:00\', \'+02:00\')), device_id, device_name ORDER BY date ASC, hour_num ASC, device_id';
        
        const [rows] = await pool.execute(query, params);
        return rows;
    } catch (error) {
        console.error('Ошибка получения почасовых данных:', error.message);
        throw error;
    }
}

/**
 * Получает данные агрегированные по 10 минут за период (для графика)
 */
async function getTenMinuteData(deviceId = null, startDate = null, endDate = null) {
    const pool = getPool();
    
    try {
        let query = `
            SELECT 
                DATE_FORMAT(
                    DATE_ADD(
                        DATE_FORMAT(CONVERT_TZ(timestamp, '+00:00', '+02:00'), '%Y-%m-%d %H:%i'),
                        INTERVAL -MINUTE(CONVERT_TZ(timestamp, '+00:00', '+02:00')) % 10 MINUTE
                    ),
                    '%Y-%m-%d %H:%i'
                ) as ten_minute,
                DATE(CONVERT_TZ(timestamp, '+00:00', '+02:00')) as date,
                device_id,
                device_name,
                COUNT(*) as total_checks,
                SUM(is_online) as minutes_online,
                COUNT(*) - SUM(is_online) as minutes_offline,
                ROUND((SUM(is_online) / COUNT(*)) * 100, 2) as availability_percent,
                AVG(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w END) as avg_power_w,
                -- Для агрегированных данных: средняя мощность * количество минут онлайн / 60 (чтобы получить кВт·ч)
                -- Используем COALESCE чтобы вернуть 0 если нет данных
                COALESCE(AVG(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w END) * (SUM(is_online) / 60.0), 0) as total_consumption_kwh
            FROM power_status
            WHERE 1=1
        `;
        
        const params = [];
        
        if (deviceId) {
            query += ' AND device_id = ?';
            params.push(deviceId);
        }
        
        if (startDate) {
            query += ' AND DATE(CONVERT_TZ(timestamp, \'+00:00\', \'+02:00\')) >= ?';
            params.push(startDate);
        }
        
        if (endDate) {
            query += ' AND DATE(CONVERT_TZ(timestamp, \'+00:00\', \'+02:00\')) <= ?';
            params.push(endDate);
        }
        
        query += ' GROUP BY DATE_FORMAT(DATE_ADD(DATE_FORMAT(CONVERT_TZ(timestamp, \'+00:00\', \'+02:00\'), \'%Y-%m-%d %H:%i\'), INTERVAL -MINUTE(CONVERT_TZ(timestamp, \'+00:00\', \'+02:00\')) % 10 MINUTE), \'%Y-%m-%d %H:%i\'), DATE(CONVERT_TZ(timestamp, \'+00:00\', \'+02:00\')), device_id, device_name ORDER BY ten_minute ASC, device_id';
        
        const [rows] = await pool.execute(query, params);
        return rows;
    } catch (error) {
        console.error('Ошибка получения данных по 10 минут:', error.message);
        throw error;
    }
}

/**
 * Получает поминутные данные за период (для графика)
 */
async function getMinuteData(deviceId = null, startDate = null, endDate = null) {
    const pool = getPool();
    
    try {
        let query = `
            SELECT 
                DATE_FORMAT(CONVERT_TZ(timestamp, '+00:00', '+02:00'), '%Y-%m-%d %H:%i') as minute,
                DATE_FORMAT(CONVERT_TZ(timestamp, '+00:00', '+02:00'), '%Y-%m-%d') as date,
                DATE_FORMAT(CONVERT_TZ(timestamp, '+00:00', '+02:00'), '%H:%i') as time,
                timestamp,
                device_id,
                device_name,
                is_online,
                CASE WHEN is_online = 1 THEN 100 ELSE 0 END as availability_percent,
                CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w ELSE NULL END as avg_power_w,
                CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w * (1.0 / 60.0) ELSE 0 END as total_consumption_kwh
            FROM power_status
            WHERE 1=1
        `;
        
        const params = [];
        
        if (deviceId) {
            query += ' AND device_id = ?';
            params.push(deviceId);
        }
        
        if (startDate) {
            query += ' AND DATE(CONVERT_TZ(timestamp, \'+00:00\', \'+02:00\')) >= ?';
            params.push(startDate);
        }
        
        if (endDate) {
            query += ' AND DATE(CONVERT_TZ(timestamp, \'+00:00\', \'+02:00\')) <= ?';
            params.push(endDate);
        }
        
        query += ' ORDER BY CONVERT_TZ(timestamp, \'+00:00\', \'+02:00\') ASC, device_id';
        
        const [rows] = await pool.execute(query, params);
        return rows;
    } catch (error) {
        console.error('Ошибка получения поминутных данных:', error.message);
        throw error;
    }
}

/**
 * Проверяет подключение к базе данных
 */
async function testConnection() {
    try {
        const pool = getPool();
        const [rows] = await pool.execute('SELECT 1 as test');
        return rows[0].test === 1;
    } catch (error) {
        console.error('Ошибка подключения к MySQL:', error.message);
        return false;
    }
}

module.exports = {
    getPool,
    closePool,
    savePowerStatus,
    getStats,
    getDailyDetails,
    getDailyChart,
    getOverallStats,
    getDailyPowerConsumption,
    getDailyPowerDetails,
    getHourlyData,
    getTenMinuteData,
    getMinuteData,
    testConnection
};
