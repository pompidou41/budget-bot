import { z } from 'zod/v4';

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1, 'Telegram bot token is required'),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().email('Invalid service account email'),
  GOOGLE_PRIVATE_KEY: z.string().min(1, 'Google private key is required'),
  ADMIN_USER_ID: z.coerce.number().int().positive().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment variables:');
    console.error(result.error.format());
    process.exit(1);
  }

  return result.data;
}
