import "dotenv/config";
import { PgBoss } from "pg-boss";
import { loadConfig } from "./config";
import { buildLogger } from "./logger";
import { initSentry } from "./sentry";
import { buildSupabaseClient } from "./supabase";
import { buildServer } from "./server";
import { createDbPool } from "./db";
import { registerWorkers } from "./workers";
import { scheduleKickoff } from "./queue";

const config = loadConfig();
const logger = buildLogger(config);
initSentry(config);

const boss = new PgBoss({ connectionString: config.databaseUrl });
const db = createDbPool(config.databaseUrl);
const supabase = buildSupabaseClient(config);

async function start() {
  await boss.start();
  await registerWorkers({ boss, db, logger, config });
  await scheduleKickoff(boss, config, logger);

  const app = await buildServer({ config, logger, boss, db, supabase });
  await app.listen({ port: config.port, host: "0.0.0.0" });

  logger.info({ port: config.port }, "Jobs service running");

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
  logger.error({ err: error }, "Failed to start jobs service");
  process.exit(1);
});
