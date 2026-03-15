import winston from 'winston';

let _logger: winston.Logger | null = null;

export function createLogger(level = 'info'): winston.Logger {
  _logger = winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      winston.format.errors({ stack: true }),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
        return `${timestamp} [${level.toUpperCase()}] ${message}${metaStr}`;
      })
    ),
    transports: [new winston.transports.Console()],
  });
  return _logger;
}

export function getLogger(): winston.Logger {
  if (!_logger) throw new Error('Logger not initialized. Call createLogger() first.');
  return _logger;
}
