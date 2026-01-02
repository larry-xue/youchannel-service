import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ADMIN_ORIGIN: z.string().min(1).default("http://localhost:5173"),
  OPENAPI_SHARED_KEY: z.string().min(1),
  KICKOFF_CRON: z.string().optional(),
  KICKOFF_BATCH_LIMIT: z.coerce.number().int().positive().default(50),
  SYNC_INTERVAL_SEC: z.coerce.number().int().positive().default(3600),
  LOG_LEVEL: z.string().default("info"),
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENV: z.string().optional()
});

export type Config = {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  adminOrigin: string;
  openapiSharedKey: string;
  kickoffCron?: string;
  kickoffBatchLimit: number;
  syncIntervalSec: number;
  logLevel: string;
  sentryDsn?: string;
  sentryEnv?: string;
};

export function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const formatted = parsed.error.flatten().fieldErrors;
    throw new Error(`Invalid environment configuration: ${JSON.stringify(formatted)}`);
  }

  return {
    nodeEnv: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    databaseUrl: parsed.data.DATABASE_URL,
    supabaseUrl: parsed.data.SUPABASE_URL,
    supabaseServiceRoleKey: parsed.data.SUPABASE_SERVICE_ROLE_KEY,
    adminOrigin: parsed.data.ADMIN_ORIGIN,
    openapiSharedKey: parsed.data.OPENAPI_SHARED_KEY,
    kickoffCron: parsed.data.KICKOFF_CRON,
    kickoffBatchLimit: parsed.data.KICKOFF_BATCH_LIMIT,
    syncIntervalSec: parsed.data.SYNC_INTERVAL_SEC,
    logLevel: parsed.data.LOG_LEVEL,
    sentryDsn: parsed.data.SENTRY_DSN,
    sentryEnv: parsed.data.SENTRY_ENV
  };
}
