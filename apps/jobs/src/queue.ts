import type { PgBoss, SendOptions } from "pg-boss";
import type { Logger } from "pino";
import type { Config } from "./config";

const SYNC_RETRY_LIMIT = 5;
const SYNC_RETRY_DELAY_SEC = 60;
const SYNC_RETRY_DELAY_MAX_SEC = 600;

export async function scheduleKickoff(boss: PgBoss, config: Config, logger: Logger) {
  if (!config.kickoffCron) {
    logger.info("KICKOFF_CRON not set, skipping schedule");
    return;
  }

  await boss.schedule("kickoff", config.kickoffCron, { source: "schedule" });
  logger.info({ cron: config.kickoffCron }, "Kickoff schedule registered");
}

export function buildSyncPlaylistJobOptions(playlistId?: string | null): SendOptions {
  return {
    singletonKey: playlistId ? `playlist.${playlistId}` : undefined,
    retryLimit: SYNC_RETRY_LIMIT,
    retryDelay: SYNC_RETRY_DELAY_SEC,
    retryBackoff: true,
    retryDelayMax: SYNC_RETRY_DELAY_MAX_SEC
  };
}
