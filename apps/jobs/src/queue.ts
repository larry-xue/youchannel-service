import type PgBoss from "pg-boss";
import type { Logger } from "pino";
import type { Config } from "./config";

export async function scheduleKickoff(boss: PgBoss, config: Config, logger: Logger) {
  if (!config.kickoffCron) {
    logger.info("KICKOFF_CRON not set, skipping schedule");
    return;
  }

  await boss.schedule("kickoff", config.kickoffCron, { source: "schedule" });
  logger.info({ cron: config.kickoffCron }, "Kickoff schedule registered");
}