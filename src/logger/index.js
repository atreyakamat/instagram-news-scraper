import winston from 'winston';

const { combine, timestamp, colorize, printf, json } = winston.format;

const consoleFormat = printf(({ level, message, timestamp, module, ...meta }) => {
    const mod = module ? `[${module}] ` : '';
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level}: ${mod}${message}${metaStr}`;
});

let rootLogger = null;

export function createLogger(module) {
    if (!rootLogger) {
        rootLogger = winston.createLogger({
            level: process.env.LOG_LEVEL || 'info',
            format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), json()),
            transports: [
                new winston.transports.Console({
                    format: combine(
                        colorize(),
                        timestamp({ format: 'HH:mm:ss' }),
                        consoleFormat
                    ),
                }),
                new winston.transports.File({
                    filename: 'logs/scraper.log',
                    format: combine(timestamp(), json()),
                    maxsize: 10 * 1024 * 1024, // 10MB
                    maxFiles: 3,
                }),
            ],
        });
    }

    return rootLogger.child({ module });
}
