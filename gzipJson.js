/**
 * Сжатие JSON-ответов gzip без внешних зависимостей.
 * /api/minute отдаёт 0.4 МБ (сутки) … 4 МБ (7 дней) несжатого JSON, а Cloud Run сам не сжимает.
 * JSON поминутных данных сжимается примерно в 10–20 раз.
 */
'use strict';

const zlib = require('zlib');

const MIN_BYTES = 1024;

function gzipJson(req, res, next) {
    const originalJson = res.json.bind(res);
    res.json = (body) => {
        const accept = String(req.headers['accept-encoding'] || '');
        if (!/\bgzip\b/i.test(accept) || res.headersSent) return originalJson(body);
        const raw = Buffer.from(JSON.stringify(body), 'utf8');
        if (raw.length < MIN_BYTES) return originalJson(body);
        zlib.gzip(raw, { level: 6 }, (err, gz) => {
            if (err || res.headersSent) {
                if (!res.headersSent) originalJson(body);
                return;
            }
            res.set('Content-Type', 'application/json; charset=utf-8');
            res.set('Content-Encoding', 'gzip');
            res.append('Vary', 'Accept-Encoding');
            res.set('Content-Length', String(gz.length));
            res.end(gz);
        });
        return res;
    };
    next();
}

module.exports = { gzipJson };
