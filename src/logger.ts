import pino from 'pino';

// Production (PM2) gets plain JSON lines; pretty output is for local development only
const isProduction = process.env.NODE_ENV === 'production';

// Code logs errors as `{ error }`; pino serializes only `err` by default, so map both
const serializers = { error: pino.stdSerializers.err, err: pino.stdSerializers.err };

export const logger = pino(
  isProduction
    ? { serializers }
    : {
        serializers,
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
