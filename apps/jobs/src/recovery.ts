import type { PgBoss } from "pg-boss";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import type { DbPool } from "./db.js";

export type RecoveryResult = {
  recoveredQueued: number;
  recoveredProcessing: number;
  recoveredFailed: number;
};

type OrphanedJob = {
  id: string;
  video_id: string;
  user_id: string;
};

type FailedJob = {
  id: string;
  video_id: string;
  user_id: string;
  failed_count: number;
};

/**
 * Recover stale processing jobs that have exceeded the timeout.
 * Uses SELECT FOR UPDATE SKIP LOCKED to prevent concurrent recovery.
 */
async function recoverStaleProcessingJobs(params: {
  boss: PgBoss;
  db: DbPool;
  logger: Logger;
  config: Config;
  instanceId: string;
}): Promise<number> {
  const { db, boss, logger, config } = params;
  const timeoutMs = config.analysisProcessingTimeoutMs;

  // Reset stale processing jobs to queued status
  const result = await db.query<OrphanedJob>(
    `WITH stale_jobs AS (
      SELECT id, video_id, user_id
      FROM video_analyses
      WHERE status = 'processing'
        AND claimed_at < NOW() - ($1 || ' milliseconds')::interval
      FOR UPDATE SKIP LOCKED
      LIMIT 10
    )
    UPDATE video_analyses va
    SET 
      status = 'queued',
      claimed_at = NULL,
      claimed_by = NULL,
      error = 'Recovered from stale processing state'
    FROM stale_jobs sj
    WHERE va.id = sj.id
    RETURNING va.id, va.video_id, va.user_id`,
    [timeoutMs]
  );

  // Re-enqueue recovered jobs to pg-boss
  for (const job of result.rows) {
    try {
      const sent = await boss.send(
        "analyze.video",
        { videoId: job.video_id, userId: job.user_id },
        { singletonKey: `analysis.${job.video_id}` }
      );
      if (sent) {
        logger.info(
          { videoId: job.video_id, analysisId: job.id },
          "Recovered stale processing job"
        );
      }
    } catch (error) {
      logger.error(
        { videoId: job.video_id, analysisId: job.id, err: error },
        "Failed to re-enqueue recovered processing job"
      );
    }
  }

  return result.rows.length;
}

/**
 * Recover orphaned queued jobs that may have lost their pg-boss job.
 * Uses singletonKey to prevent duplicate pg-boss jobs.
 */
async function recoverOrphanedQueuedJobs(params: {
  boss: PgBoss;
  db: DbPool;
  logger: Logger;
}): Promise<number> {
  const { db, boss, logger } = params;

  // Find queued jobs that haven't been claimed (potential orphans)
  const result = await db.query<OrphanedJob>(
    `SELECT id, video_id, user_id
     FROM video_analyses
     WHERE status = 'queued'
       AND claimed_at IS NULL
     LIMIT 50`
  );

  let recovered = 0;
  for (const job of result.rows) {
    try {
      // singletonKey ensures we don't create duplicate pg-boss jobs
      const sent = await boss.send(
        "analyze.video",
        { videoId: job.video_id, userId: job.user_id },
        { singletonKey: `analysis.${job.video_id}` }
      );
      if (sent) {
        logger.info(
          { videoId: job.video_id, analysisId: job.id },
          "Recovered orphaned queued job"
        );
        recovered += 1;
      }
      // If sent is null, the job already exists in pg-boss, which is fine
    } catch (error) {
      logger.error(
        { videoId: job.video_id, analysisId: job.id, err: error },
        "Failed to re-enqueue orphaned queued job"
      );
    }
  }

  return recovered;
}

/**
 * Recover failed jobs that are eligible for retry.
 * Uses SELECT FOR UPDATE SKIP LOCKED to prevent concurrent recovery.
 */
async function recoverRetryableFailedJobs(params: {
  boss: PgBoss;
  db: DbPool;
  logger: Logger;
  config: Config;
}): Promise<number> {
  const { db, boss, logger, config } = params;
  const maxRetryCount = config.analysisMaxRetryCount;
  const retryDelayMs = config.analysisFailedRetryDelayMs;

  // Find failed jobs eligible for retry
  const result = await db.query<FailedJob>(
    `WITH retryable_jobs AS (
      SELECT id, video_id, user_id, failed_count
      FROM video_analyses
      WHERE status = 'failed'
        AND failed_count < $1
        AND updated_at < NOW() - ($2 || ' milliseconds')::interval
      FOR UPDATE SKIP LOCKED
      LIMIT 10
    )
    UPDATE video_analyses va
    SET 
      status = 'queued',
      claimed_at = NULL,
      claimed_by = NULL
    FROM retryable_jobs rj
    WHERE va.id = rj.id
    RETURNING va.id, va.video_id, va.user_id, va.failed_count`,
    [maxRetryCount, retryDelayMs]
  );

  // Re-enqueue recovered jobs to pg-boss
  for (const job of result.rows) {
    try {
      const sent = await boss.send(
        "analyze.video",
        { videoId: job.video_id, userId: job.user_id },
        { singletonKey: `analysis.${job.video_id}` }
      );
      if (sent) {
        logger.info(
          { videoId: job.video_id, analysisId: job.id, failedCount: job.failed_count },
          "Recovered failed job for retry"
        );
      }
    } catch (error) {
      logger.error(
        { videoId: job.video_id, analysisId: job.id, err: error },
        "Failed to re-enqueue failed job"
      );
    }
  }

  return result.rows.length;
}

/**
 * Main recovery function that handles all orphaned/stale/failed jobs.
 */
export async function recoverOrphanedJobs(params: {
  boss: PgBoss;
  db: DbPool;
  logger: Logger;
  config: Config;
  instanceId: string;
}): Promise<RecoveryResult> {
  const { logger, instanceId } = params;

  logger.debug({ instanceId }, "Starting job recovery check");

  try {
    const [recoveredProcessing, recoveredQueued, recoveredFailed] = await Promise.all([
      recoverStaleProcessingJobs(params),
      recoverOrphanedQueuedJobs(params),
      recoverRetryableFailedJobs(params)
    ]);

    const total = recoveredProcessing + recoveredQueued + recoveredFailed;
    if (total > 0) {
      logger.info(
        { recoveredProcessing, recoveredQueued, recoveredFailed, instanceId },
        "Job recovery completed"
      );
    }

    return { recoveredQueued, recoveredProcessing, recoveredFailed };
  } catch (error) {
    logger.error({ err: error, instanceId }, "Job recovery failed");
    return { recoveredQueued: 0, recoveredProcessing: 0, recoveredFailed: 0 };
  }
}

/**
 * Start a periodic recovery scheduler.
 * Returns a function to stop the scheduler.
 */
export function startRecoveryScheduler(params: {
  boss: PgBoss;
  db: DbPool;
  logger: Logger;
  config: Config;
  instanceId: string;
}): () => void {
  const { config, logger, instanceId } = params;
  const intervalMs = config.analysisRecoveryIntervalMs;

  logger.info(
    { intervalMs, instanceId },
    "Starting job recovery scheduler"
  );

  const intervalId = setInterval(async () => {
    await recoverOrphanedJobs(params);
  }, intervalMs);

  // Return stop function
  return () => {
    logger.info({ instanceId }, "Stopping job recovery scheduler");
    clearInterval(intervalId);
  };
}
