import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";

// Load .env file explicitly from the jobs app directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = resolve(__dirname, "../.env");
const result = config({ path: envPath });

if (result.error && !result.parsed) {
  console.warn(`Warning: Could not load .env file from ${envPath}`);
}

import { PgBoss } from "pg-boss";
import type { Logger } from "pino";
import type { Config } from "@jobs/config";
import { loadConfig } from "@jobs/config";
import { buildLogger } from "@jobs/logger";
import { initSentry } from "@jobs/sentry";
import { buildSupabaseClient } from "@jobs/supabase";
import { buildServer } from "@jobs/server";
import { createDbPool } from "@jobs/db";
import { registerWorkers } from "@jobs/workers";


function isValidDatabaseUrl(databaseUrl: string) {
  try {
    const parsed = new URL(databaseUrl);
    return Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function encodeUserInfoSegment(segment: string) {
  try {
    return encodeURIComponent(decodeURIComponent(segment));
  } catch {
    return encodeURIComponent(segment);
  }
}

function encodeDatabaseUrlUserInfo(databaseUrl: string) {
  const schemeSeparatorIndex = databaseUrl.indexOf("://");
  if (schemeSeparatorIndex === -1) {
    return databaseUrl;
  }

  const scheme = databaseUrl.slice(0, schemeSeparatorIndex);
  const afterScheme = databaseUrl.slice(schemeSeparatorIndex + 3);
  const atIndex = afterScheme.lastIndexOf("@");
  if (atIndex === -1) {
    return databaseUrl;
  }

  const userInfo = afterScheme.slice(0, atIndex);
  const hostAndPath = afterScheme.slice(atIndex + 1);
  const colonIndex = userInfo.indexOf(":");
  if (colonIndex === -1) {
    return databaseUrl;
  }

  const username = userInfo.slice(0, colonIndex);
  const password = userInfo.slice(colonIndex + 1);
  const encodedUsername = encodeUserInfoSegment(username);
  const encodedPassword = encodeUserInfoSegment(password);

  return `${scheme}://${encodedUsername}:${encodedPassword}@${hostAndPath}`;
}

function normalizeDatabaseUrl(databaseUrl: string, logger: Logger) {
  if (isValidDatabaseUrl(databaseUrl)) {
    return databaseUrl;
  }

  const encoded = encodeDatabaseUrlUserInfo(databaseUrl);
  if (encoded !== databaseUrl && isValidDatabaseUrl(encoded)) {
    logger.warn("DATABASE_URL contained unescaped characters in the username or password. Applied percent-encoding.");
    return encoded;
  }

  return databaseUrl;
}

function generateInstanceId() {
  return `${hostname()}-${process.pid}-${Date.now()}`;
}

let configObj: Config;
let logger: Logger;

try {
  configObj = loadConfig();
  logger = buildLogger(configObj);
  initSentry(configObj);
} catch (error) {
  console.error("Failed to load configuration:", error);
  process.exit(1);
}

const databaseUrl = normalizeDatabaseUrl(configObj.databaseUrl, logger);

// Validate database URL before using it
if (!databaseUrl || typeof databaseUrl !== "string" || databaseUrl.trim() === "" || !isValidDatabaseUrl(databaseUrl)) {
  logger.error("Invalid DATABASE_URL configuration. If your password contains special characters, URL-encode it.");
  process.exit(1);
}

let boss: PgBoss;
let db: ReturnType<typeof createDbPool>;
let supabase: ReturnType<typeof buildSupabaseClient>;

try {
  boss = new PgBoss({ connectionString: databaseUrl });
  db = createDbPool(databaseUrl);
  supabase = buildSupabaseClient(configObj);
} catch (error) {
  logger.error({ err: error }, "Failed to initialize database connections");
  process.exit(1);
}

// Handle pg-boss errors to prevent unhandled error crashes
boss.on("error", (error) => {
  logger.error({ err: error }, "pg-boss error occurred");
  // If the error indicates schema is missing, it's likely the database was reset
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message: string }).message;
    if (message.includes("pgboss") && message.includes("does not exist")) {
      logger.error("pg-boss schema appears to be missing. Database may have been reset. Exiting for restart...");
      process.exit(1);
    }
  }
});

async function start() {
  // Generate unique instance ID for this worker
  const instanceId = generateInstanceId();
  logger.info({ instanceId }, "Starting jobs service...");

  logger.info("Starting pg-boss...");
  try {
    await boss.start();
    logger.info("pg-boss started successfully");
  } catch (error) {
    logger.error({ err: error }, "Failed to start pg-boss");
    throw error;
  }

  await registerWorkers({ boss, db, logger, config: configObj, instanceId });

  const app = await buildServer({ config: configObj, logger, boss, db, supabase });
  await app.listen({ port: configObj.port, host: "0.0.0.0" });

  logger.info({ port: configObj.port, instanceId }, "Jobs service running");

  const shutdown = async () => {
    logger.info("Shutting down...");
    await app.close();
    await boss.stop();
    await db.end();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((error) => {
  if (logger) {
    logger.error({ err: error }, "Failed to start jobs service");
  } else {
    console.error("Failed to start jobs service:", error);
  }
  process.exit(1);
});
