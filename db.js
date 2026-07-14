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

// Часовой пояс Киева (Europe/Kyiv в IANA; в MySQL — Europe/Kiev). DST автоматически.
const KYIV_TZ = 'Europe/Kiev';
const KYIV_DATE_SQL = `DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '${KYIV_TZ}'))`;

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
async function savePowerStatus(deviceId, deviceName, isOnline, responseTimeMs = null, powerConsumptionW = null, voltageV = null, ecoflowChargePercent = null, errorMessage = null, temperatureC = null, humidityPercent = null, switchOn = null) {
    const pool = getPool();
    
    try {
        const query = `
            INSERT INTO power_status 
            (timestamp, device_id, device_name, is_online, switch_on, response_time_ms, power_consumption_w, voltage_v, ecoflow_charge_percent, temperature_c, humidity_percent, error_message)
            VALUES (NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        const [result] = await pool.execute(query, [
            deviceId,
            deviceName,
            isOnline ? 1 : 0,
            switchOn === null || switchOn === undefined ? null : (switchOn ? 1 : 0),
            responseTimeMs,
            powerConsumptionW,
            voltageV,
            ecoflowChargePercent,
            temperatureC,
            humidityPercent,
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
                DATE(CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev')) as date,
                device_id,
                device_name,
                COUNT(*) as total_checks,
                SUM(is_online) as minutes_online,
                COUNT(*) - SUM(is_online) as minutes_offline,
                AVG(CASE WHEN response_time_ms IS NOT NULL THEN response_time_ms END) as avg_response_time_ms,
                AVG(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w END) as avg_power_w,
                -- Потребление: power_w * (1/60) часа / 1000 = кВт·ч
                SUM(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w * (1.0 / 60.0) / 1000.0 ELSE 0 END) as total_consumption_kwh,
                AVG(CASE WHEN device_id = 'ecoflow' AND ecoflow_charge_percent IS NOT NULL THEN ecoflow_charge_percent END) as ecoflow_charge_percent
            FROM power_status
            WHERE 1=1
        `;
        
        const params = [];
        
        if (deviceId) {
            query += ' AND device_id = ?';
            params.push(deviceId);
        }
        
        if (startDate) {
            query += ' AND DATE(CONVERT_TZ(timestamp, \'+00:00\', \'Europe/Kiev\')) >= ?';
            params.push(startDate);
        }
        
        if (endDate) {
            query += ' AND DATE(CONVERT_TZ(timestamp, \'+00:00\', \'Europe/Kiev\')) <= ?';
            params.push(endDate);
        }
        
        query += ' GROUP BY DATE(CONVERT_TZ(timestamp, \'+00:00\', \'Europe/Kiev\')), device_id, device_name ORDER BY date DESC, device_id';
        
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
                DATE_FORMAT(CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev'), '%Y-%m-%d %H:%i') as time,
                timestamp,
                is_online,
                response_time_ms,
                power_consumption_w,
                voltage_v,
                ecoflow_charge_percent,
                error_message
            FROM power_status
            WHERE device_id = ? AND DATE(CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev')) = ?
            ORDER BY CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev') ASC
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
                    DATE(CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev')) as date,
                    device_id,
                    device_name,
                    COUNT(*) as total_checks,
                    SUM(is_online) as minutes_online,
                    COUNT(*) - SUM(is_online) as minutes_offline,
                    ROUND((SUM(is_online) / COUNT(*)) * 100, 2) as availability_percent,
                    AVG(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w END) as avg_power_w,
                    -- Потребление: power_w * (1/60) часа / 1000 = кВт·ч
                    SUM(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w * (1.0 / 60.0) / 1000.0 ELSE 0 END) as total_consumption_kwh,
                    AVG(CASE WHEN device_id = 'ecoflow' AND ecoflow_charge_percent IS NOT NULL THEN ecoflow_charge_percent END) as ecoflow_charge_percent
                FROM power_status
                WHERE DATE(CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev')) = ${KYIV_DATE_SQL}
                ${deviceId ? 'AND device_id = ?' : ''}
                GROUP BY DATE(CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev')), device_id, device_name
                ORDER BY date DESC, device_id
            `;
            
            params = deviceId ? [deviceId] : [];
        } else {
            query = `
                SELECT 
                    DATE(CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev')) as date,
                    device_id,
                    device_name,
                    COUNT(*) as total_checks,
                    SUM(is_online) as minutes_online,
                    COUNT(*) - SUM(is_online) as minutes_offline,
                    ROUND((SUM(is_online) / COUNT(*)) * 100, 2) as availability_percent,
                    AVG(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w END) as avg_power_w,
                    -- Потребление: power_w * (1/60) часа / 1000 = кВт·ч
                    SUM(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w * (1.0 / 60.0) / 1000.0 ELSE 0 END) as total_consumption_kwh,
                    AVG(CASE WHEN device_id = 'ecoflow' AND ecoflow_charge_percent IS NOT NULL THEN ecoflow_charge_percent END) as ecoflow_charge_percent
                FROM power_status
                WHERE CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev') >= DATE_SUB(${KYIV_DATE_SQL}, INTERVAL ? DAY)
                ${deviceId ? 'AND device_id = ?' : ''}
                GROUP BY DATE(CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev')), device_id, device_name
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
                -- Потребление: power_w * (1/60) часа / 1000 = кВт·ч
                SUM(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w * (1.0 / 60.0) / 1000.0 ELSE 0 END) as total_consumption_kwh,
                AVG(CASE WHEN device_id = 'ecoflow' AND ecoflow_charge_percent IS NOT NULL THEN ecoflow_charge_percent END) as ecoflow_charge_percent
            FROM power_status
            WHERE 1=1
        `;
        
        const params = [];
        
        if (deviceId) {
            query += ' AND device_id = ?';
            params.push(deviceId);
        }
        
        if (startDate) {
            query += ' AND DATE(CONVERT_TZ(timestamp, \'+00:00\', \'Europe/Kiev\')) >= ?';
            params.push(startDate);
        }
        
        if (endDate) {
            query += ' AND DATE(CONVERT_TZ(timestamp, \'+00:00\', \'Europe/Kiev\')) <= ?';
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
                DATE(CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev')) as date,
                device_id,
                device_name,
                COUNT(CASE WHEN power_consumption_w IS NOT NULL THEN 1 END) as readings_count,
                AVG(power_consumption_w) as avg_power_w,
                -- Сумма: каждая минута с потреблением = power_w * (1/60) часа / 1000 = кВт*ч
                SUM(power_consumption_w * (1.0 / 60.0) / 1000.0) as total_consumption_kwh
            FROM power_status
            WHERE is_online = 1 AND power_consumption_w IS NOT NULL
        `;
        
        const params = [];
        
        if (deviceId) {
            query += ' AND device_id = ?';
            params.push(deviceId);
        }
        
        if (startDate) {
            query += ' AND DATE(CONVERT_TZ(timestamp, \'+00:00\', \'Europe/Kiev\')) >= ?';
            params.push(startDate);
        }
        
        if (endDate) {
            query += ' AND DATE(CONVERT_TZ(timestamp, \'+00:00\', \'Europe/Kiev\')) <= ?';
            params.push(endDate);
        }
        
        query += ' GROUP BY DATE(CONVERT_TZ(timestamp, \'+00:00\', \'Europe/Kiev\')), device_id, device_name ORDER BY date DESC, device_id';
        
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
                DATE_FORMAT(CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev'), '%Y-%m-%d %H:%i') as time,
                timestamp,
                power_consumption_w,
                is_online
            FROM power_status
            WHERE device_id = ? AND DATE(CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev')) = ?
            ORDER BY CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev') ASC
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
                DATE_FORMAT(CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev'), '%Y-%m-%d %H:00') as hour,
                DATE(CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev')) as date,
                HOUR(CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev')) as hour_num,
                device_id,
                device_name,
                COUNT(*) as total_checks,
                SUM(is_online) as minutes_online,
                COUNT(*) - SUM(is_online) as minutes_offline,
                ROUND((SUM(is_online) / COUNT(*)) * 100, 2) as availability_percent,
                AVG(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w END) as avg_power_w,
                -- Для агрегированных данных: средняя мощность * количество минут онлайн / 60 / 1000 (чтобы получить кВт·ч)
                COALESCE(AVG(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w END) * (SUM(is_online) / 60.0) / 1000.0, 0) as total_consumption_kwh,
                AVG(CASE WHEN is_online = 1 AND voltage_v IS NOT NULL THEN voltage_v END) as voltage_v,
                AVG(CASE WHEN device_id = 'ecoflow' AND ecoflow_charge_percent IS NOT NULL THEN ecoflow_charge_percent END) as ecoflow_charge_percent,
                AVG(temperature_c) as temperature_c,
                AVG(humidity_percent) as humidity_percent
            FROM power_status
            WHERE 1=1
        `;
        
        const params = [];
        
        if (deviceId) {
            query += ' AND device_id = ?';
            params.push(deviceId);
        }
        
        if (startDate) {
            query += ' AND DATE(CONVERT_TZ(timestamp, \'+00:00\', \'Europe/Kiev\')) >= ?';
            params.push(startDate);
        }
        
        if (endDate) {
            query += ' AND DATE(CONVERT_TZ(timestamp, \'+00:00\', \'Europe/Kiev\')) <= ?';
            params.push(endDate);
        }
        
        query += ' GROUP BY DATE(CONVERT_TZ(timestamp, \'+00:00\', \'Europe/Kiev\')), HOUR(CONVERT_TZ(timestamp, \'+00:00\', \'Europe/Kiev\')), device_id, device_name ORDER BY date ASC, hour_num ASC, device_id';
        
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
                        DATE_FORMAT(CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev'), '%Y-%m-%d %H:%i'),
                        INTERVAL -MINUTE(CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev')) % 10 MINUTE
                    ),
                    '%Y-%m-%d %H:%i'
                ) as ten_minute,
                DATE(CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev')) as date,
                device_id,
                device_name,
                COUNT(*) as total_checks,
                SUM(is_online) as minutes_online,
                COUNT(*) - SUM(is_online) as minutes_offline,
                ROUND((SUM(is_online) / COUNT(*)) * 100, 2) as availability_percent,
                AVG(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w END) as avg_power_w,
                -- Для агрегированных данных: средняя мощность * количество минут онлайн / 60 / 1000 (чтобы получить кВт·ч)
                -- Используем COALESCE чтобы вернуть 0 если нет данных
                COALESCE(AVG(CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w END) * (SUM(is_online) / 60.0) / 1000.0, 0) as total_consumption_kwh,
                AVG(CASE WHEN is_online = 1 AND voltage_v IS NOT NULL THEN voltage_v END) as voltage_v,
                AVG(CASE WHEN device_id = 'ecoflow' AND ecoflow_charge_percent IS NOT NULL THEN ecoflow_charge_percent END) as ecoflow_charge_percent,
                AVG(temperature_c) as temperature_c,
                AVG(humidity_percent) as humidity_percent
            FROM power_status
            WHERE 1=1
        `;
        
        const params = [];
        
        if (deviceId) {
            query += ' AND device_id = ?';
            params.push(deviceId);
        }
        
        if (startDate) {
            query += ' AND DATE(CONVERT_TZ(timestamp, \'+00:00\', \'Europe/Kiev\')) >= ?';
            params.push(startDate);
        }
        
        if (endDate) {
            query += ' AND DATE(CONVERT_TZ(timestamp, \'+00:00\', \'Europe/Kiev\')) <= ?';
            params.push(endDate);
        }
        
        query += ' GROUP BY DATE_FORMAT(DATE_ADD(DATE_FORMAT(CONVERT_TZ(timestamp, \'+00:00\', \'Europe/Kiev\'), \'%Y-%m-%d %H:%i\'), INTERVAL -MINUTE(CONVERT_TZ(timestamp, \'+00:00\', \'Europe/Kiev\')) % 10 MINUTE), \'%Y-%m-%d %H:%i\'), DATE(CONVERT_TZ(timestamp, \'+00:00\', \'Europe/Kiev\')), device_id, device_name ORDER BY ten_minute ASC, device_id';
        
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
                DATE_FORMAT(CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev'), '%Y-%m-%d %H:%i') as minute,
                DATE_FORMAT(CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev'), '%Y-%m-%d') as date,
                DATE_FORMAT(CONVERT_TZ(timestamp, '+00:00', 'Europe/Kiev'), '%H:%i') as time,
                timestamp,
                device_id,
                device_name,
                is_online,
                CASE WHEN is_online = 1 THEN 100 ELSE 0 END as availability_percent,
                CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w ELSE NULL END as avg_power_w,
                -- Потребление за минуту: power_w * (1/60) часа / 1000 = кВт·ч
                CASE WHEN is_online = 1 AND power_consumption_w IS NOT NULL THEN power_consumption_w * (1.0 / 60.0) / 1000.0 ELSE 0 END as total_consumption_kwh,
                CASE WHEN is_online = 1 AND voltage_v IS NOT NULL THEN voltage_v ELSE NULL END as voltage_v,
                CASE WHEN device_id = 'ecoflow' THEN ecoflow_charge_percent ELSE NULL END as ecoflow_charge_percent,
                temperature_c,
                humidity_percent
            FROM power_status
            WHERE 1=1
        `;
        
        const params = [];
        
        if (deviceId) {
            query += ' AND device_id = ?';
            params.push(deviceId);
        }
        
        if (startDate) {
            query += ' AND DATE(CONVERT_TZ(timestamp, \'+00:00\', \'Europe/Kiev\')) >= ?';
            params.push(startDate);
        }
        
        if (endDate) {
            query += ' AND DATE(CONVERT_TZ(timestamp, \'+00:00\', \'Europe/Kiev\')) <= ?';
            params.push(endDate);
        }
        
        query += ' ORDER BY CONVERT_TZ(timestamp, \'+00:00\', \'Europe/Kiev\') ASC, device_id';
        
        const [rows] = await pool.execute(query, params);
        return rows;
    } catch (error) {
        console.error('Ошибка получения поминутных данных:', error.message);
        throw error;
    }
}

/**
 * Последняя запись по каждому устройству (текущий снимок из БД)
 */
async function getCurrentStatus() {
    const pool = getPool();

    try {
        const query = `
            SELECT
                ps.device_id,
                ps.device_name,
                ps.is_online,
                ps.switch_on,
                ps.response_time_ms,
                ps.power_consumption_w,
                ps.voltage_v,
                ps.ecoflow_charge_percent,
                ps.temperature_c,
                ps.humidity_percent,
                ps.error_message,
                ps.timestamp
            FROM power_status ps
            INNER JOIN (
                SELECT device_id, MAX(timestamp) AS max_ts
                FROM power_status
                GROUP BY device_id
            ) latest ON ps.device_id = latest.device_id AND ps.timestamp = latest.max_ts
            ORDER BY ps.device_name
        `;

        const [rows] = await pool.execute(query);
        return rows;
    } catch (error) {
        console.error('Ошибка получения текущего статуса:', error.message);
        throw error;
    }
}

async function upsertFcmToken(token, platform = 'android') {
    const pool = getPool();
    const query = `
        INSERT INTO fcm_tokens (token, platform, created_at, last_seen_at)
        VALUES (?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE platform = VALUES(platform), last_seen_at = NOW()
    `;
    await pool.execute(query, [token, platform]);
}

async function removeFcmToken(token) {
    const pool = getPool();
    await pool.execute('DELETE FROM fcm_tokens WHERE token = ?', [token]);
}

async function getAllFcmTokens() {
    const pool = getPool();
    const [rows] = await pool.execute('SELECT token FROM fcm_tokens ORDER BY last_seen_at DESC');
    return rows.map((row) => row.token);
}

/**
 * Debounced grid state: notify after 2 consecutive minutes of new raw reading.
 * @param {boolean|null} rawPresent
 * @returns {Promise<{ changed: boolean, confirmedPresent: boolean|null, shouldNotify: boolean }>}
 */
async function processGridState(rawPresent) {
    if (rawPresent === null) {
        return { changed: false, confirmedPresent: null, shouldNotify: false };
    }

    const pool = getPool();
    const rawBit = rawPresent ? 1 : 0;

    const [rows] = await pool.execute('SELECT * FROM grid_state WHERE id = 1');
    let state = rows[0];

    if (!state) {
        await pool.execute(
            'INSERT INTO grid_state (id, confirmed_present, pending_present, pending_streak) VALUES (1, NULL, ?, 1)',
            [rawBit]
        );
        return { changed: false, confirmedPresent: null, shouldNotify: false };
    }

    let pendingPresent = state.pending_present;
    let pendingStreak = state.pending_streak;
    let confirmedPresent = state.confirmed_present;

    if (pendingPresent === null || pendingPresent !== rawBit) {
        pendingPresent = rawBit;
        pendingStreak = 1;
    } else {
        pendingStreak += 1;
    }

    let shouldNotify = false;
    let changed = false;

    if (pendingStreak >= 2) {
        if (confirmedPresent === null) {
            confirmedPresent = pendingPresent;
            changed = true;
        } else if (pendingPresent !== confirmedPresent) {
            confirmedPresent = pendingPresent;
            shouldNotify = true;
            changed = true;
        }
    }

    await pool.execute(
        `UPDATE grid_state
         SET confirmed_present = ?, pending_present = ?, pending_streak = ?, updated_at = NOW()
         WHERE id = 1`,
        [confirmedPresent, pendingPresent, pendingStreak]
    );

    return {
        changed,
        confirmedPresent: confirmedPresent === null ? null : confirmedPresent === 1,
        shouldNotify,
    };
}

const CHARGE_PUSH_THRESHOLD_PERCENT = 1;

/**
 * @returns {Promise<{ confirmedPresent: boolean|null, lastPushedChargePercent: number|null }>}
 */
async function getGridPushState() {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT confirmed_present, last_pushed_charge_percent FROM grid_state WHERE id = 1'
    );
    const state = rows[0];
    if (!state) {
        return { confirmedPresent: null, lastPushedChargePercent: null };
    }
    return {
        confirmedPresent: state.confirmed_present === null
            ? null
            : state.confirmed_present === 1,
        lastPushedChargePercent: state.last_pushed_charge_percent != null
            ? Number(state.last_pushed_charge_percent)
            : null,
    };
}

/**
 * @param {number|null|undefined} chargePercent
 * @returns {Promise<{ shouldPush: boolean }>}
 */
async function evaluateChargePush(chargePercent) {
    if (chargePercent === null || chargePercent === undefined || Number.isNaN(Number(chargePercent))) {
        return { shouldPush: false };
    }

    const rounded = Math.round(Number(chargePercent));
    const { confirmedPresent, lastPushedChargePercent } = await getGridPushState();

    if (confirmedPresent === null) {
        return { shouldPush: false };
    }

    if (lastPushedChargePercent === null) {
        await recordWidgetPush(confirmedPresent, rounded);
        return { shouldPush: false };
    }

    if (Math.abs(rounded - lastPushedChargePercent) >= CHARGE_PUSH_THRESHOLD_PERCENT) {
        return { shouldPush: true };
    }

    return { shouldPush: false };
}

/**
 * @param {boolean|null} gridPresent
 * @param {number|null|undefined} chargePercent
 */
async function recordWidgetPush(gridPresent, chargePercent) {
    const pool = getPool();
    const gridBit = gridPresent === null || gridPresent === undefined ? null : (gridPresent ? 1 : 0);
    const charge = chargePercent != null && !Number.isNaN(Number(chargePercent))
        ? Math.round(Number(chargePercent))
        : null;

    await pool.execute(
        `UPDATE grid_state
         SET last_pushed_charge_percent = ?, last_pushed_grid_present = ?
         WHERE id = 1`,
        [charge, gridBit]
    );
}

/**
 * Latest snapshot for widget API.
 * @param {string} socketDeviceId
 * @param {string} ecoflowDeviceId
 * @param {(isOnline: boolean, voltageV: number|null) => boolean|null} computeGridPresent
 */
async function getLatestWidgetSnapshot(socketDeviceId, ecoflowDeviceId, computeGridPresent) {
    const rows = await getCurrentStatus();
    const socketRow = rows.find((row) => row.device_id === socketDeviceId);
    const ecoflowRow = rows.find((row) => row.device_id === ecoflowDeviceId);

    const gridPresent = socketRow
        ? computeGridPresent(socketRow.is_online === 1, socketRow.voltage_v != null ? Number(socketRow.voltage_v) : null)
        : null;

    const chargePercent = ecoflowRow && ecoflowRow.ecoflow_charge_percent != null
        ? Number(ecoflowRow.ecoflow_charge_percent)
        : null;

    const latestTimestamp = rows.reduce((latest, row) => {
        const ts = new Date(row.timestamp).getTime();
        return ts > latest ? ts : latest;
    }, 0);

    return {
        gridPresent,
        chargePercent,
        updatedAt: latestTimestamp ? new Date(latestTimestamp).toISOString() : new Date().toISOString(),
    };
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
    getCurrentStatus,
    upsertFcmToken,
    removeFcmToken,
    getAllFcmTokens,
    processGridState,
    evaluateChargePush,
    recordWidgetPush,
    getLatestWidgetSnapshot,
    testConnection
};
