import pino from 'pino';

// Production (PM2) gets plain JSON lines; pretty output is for local development only
const isProduction = process.env.NODE_ENV === 'production';

export const logger = pino(
  isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      },
);
