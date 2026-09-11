import { z } from 'zod/v4';

const DEFAULT_SPREADSHEET_ID = '1Yv9SQKDaDEpiTyyJ6LuiSnLVw1CcJEp_zLpnwBfIshE';

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// CI writes every variable into .env, so unset optional values arrive as empty strings
const withDefault = (value: string) =>
  z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).default(value));

export const envSchema = z.object({
  BOT_TOKEN: z.string().min(1, 'Telegram bot token is required'),
  OWNER_TELEGRAM_ID: z.coerce.number().int().positive(),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().email('Invalid service account email'),
  GOOGLE_PRIVATE_KEY: z.string().min(1, 'Google private key is required'),
  SPREADSHEET_ID: withDefault(DEFAULT_SPREADSHEET_ID),
  OPENROUTER_API_KEY: z.string().min(1, 'OpenRouter API key is required'),
  OPENROUTER_MODEL: withDefault('google/gemini-3.7-flash'),
  GROQ_API_KEY: z.string().min(1, 'Groq API key is required'),
  GROQ_STT_MODEL: withDefault('whisper-large-v3-turbo'),
  BOT_TIMEZONE: withDefault('Europe/Moscow').refine(isValidTimeZone, 'Invalid IANA time zone'),
  LOG_LEVEL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment variables:');
    console.error(z.prettifyError(result.error));
    process.exit(1);
  }

  return result.data;
}
