import type PgBoss from "pg-boss";
import type { Logger } from "pino";
import { captureException } from "./sentry";
import {
  insertJobRun,
  insertSyncRun,
  updateJobRunByBossId,
  updateSyncRun,
  type DbPool
} from "./db";

export async function registerWorkers(params: {
  boss: PgBoss;
  db: DbPool;
  logger: Logger;
}) {
  const { boss, db, logger } = params;

  await boss.work("kickoff", async (job) => {
    const kickoffSource = (job.data as { source?: string } | null)?.source ?? "schedule";
    const syncRun = await insertSyncRun(db, {
      kickoffSource,
      meta: { kickoffJobId: job.id }
    });

    const bossJobId = await boss.publish("sync", { syncRunId: syncRun.id });
    await insertJobRun(db, {
      syncRunId: syncRun.id,
      jobName: "sync",
      bossJobId,
      status: "queued"
    });

    logger.info({ syncRunId: syncRun.id, bossJobId }, "Kickoff scheduled sync job");
    return { syncRunId: syncRun.id, bossJobId };
  });

  await boss.work("sync", async (job) => {
    const syncRunId = (job.data as { syncRunId?: string } | null)?.syncRunId;
    if (!syncRunId) {
      throw new Error("sync job missing syncRunId");
    }

    await updateSyncRun(db, syncRunId, { status: "running", startedAt: new Date() });
    await updateJobRunByBossId(db, job.id, { status: "running", startedAt: new Date() });

    try {
      const result = { ok: true };
      await updateJobRunByBossId(db, job.id, {
        status: "succeeded",
        finishedAt: new Date(),
        result
      });
      await updateSyncRun(db, syncRunId, { status: "succeeded", finishedAt: new Date() });
      logger.info({ syncRunId }, "Sync job completed");
      return result;
    } catch (error) {
      await updateJobRunByBossId(db, job.id, {
        status: "failed",
        finishedAt: new Date(),
        error: error instanceof Error ? error.message : "unknown error"
      });
      await updateSyncRun(db, syncRunId, { status: "failed", finishedAt: new Date() });
      captureException(error);
      logger.error({ syncRunId, err: error }, "Sync job failed");
      throw error;
    }
  });
}