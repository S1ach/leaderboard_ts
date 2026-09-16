import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  ...(process.env.NODE_ENV !== 'production' && process.stdout.isTTY
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});
