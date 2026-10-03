import type { Logger } from 'pino';
import pino from 'pino';

export function createLogger(): Logger {
  const isDev = process.env['NODE_ENV'] !== 'production';
  return pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    transport: isDev
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
      : undefined,
  });
}
