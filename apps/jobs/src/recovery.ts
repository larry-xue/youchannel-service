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

type EnqueueStats = {
  enqueued: number;
  deduped: number;
  failed: number;
};

/**
 * Recover stale processing jobs that have exceeded the timeout.
 * Uses CTE + UPDATE + RETURNING for atomic operation.
 * Handles NULL claimed_at by treating them as stale (NULLS FIRST in ordering).
 */
async function recoverStaleProcessingJobs(params: {
  boss: PgBoss;
  db: DbPool;
  logger: Logger;
  config: Config;
  instanceId: string;
}): Promise<EnqueueStats> {
  const { db, boss, logger, config } = params;
  const timeoutMs = config.analysisProcessingTimeoutMs;

  // Reset stale processing jobs to queued status
  // Uses CTE + UPDATE + RETURNING for atomic operation
  // NULL claimed_at treated as stale (sorted first via NULLS FIRST)
  const result = await db.query<OrphanedJob>(
    `WITH stale_jobs AS (
      SELECT id, video_id, user_id
      FROM video_analyses
      WHERE status = 'processing'
        AND (claimed_at IS NULL OR claimed_at < NOW() - $1 * interval '1 millisecond')
      ORDER BY claimed_at ASC NULLS FIRST
      FOR UPDATE SKIP LOCKED
      LIMIT 10
    )
    UPDATE video_analyses va
    SET 
      status = 'queued',
      claimed_at = NULL,
      claimed_by = NULL,
      error = 'Recovered from stale processing state',
      updated_at = NOW()
    FROM stale_jobs sj
    WHERE va.id = sj.id
    RETURNING va.id, va.video_id, va.user_id`,
    [timeoutMs]
  );

  const stats: EnqueueStats = { enqueued: 0, deduped: 0, failed: 0 };

  // Re-enqueue recovered jobs to pg-boss
  for (const job of result.rows) {
    try {
      // Use analysisId as singletonKey to avoid cross-video interference
      const sent = await boss.send(
        "analyze.video",
        { videoId: job.video_id, userId: job.user_id, analysisId: job.id },
        { singletonKey: `analysis.${job.id}` }
      );
      if (sent) {
        stats.enqueued += 1;
        logger.info(
          { videoId: job.video_id, analysisId: job.id },
          "Recovered stale processing job"
        );
      } else {
        stats.deduped += 1;
      }
    } catch (error) {
      stats.failed += 1;
      logger.error(
        { videoId: job.video_id, analysisId: job.id, err: error },
        "Failed to re-enqueue recovered processing job"
      );
    }
  }

  if (result.rows.length > 0) {
    logger.debug(
      { selected: result.rows.length, ...stats },
      "Stale processing recovery stats"
    );
  }

  return stats;
}

/**
 * Recover orphaned queued jobs that may have lost their pg-boss job.
 * Uses CTE + UPDATE + RETURNING for atomic operation.
 */
async function recoverOrphanedQueuedJobs(params: {
  boss: PgBoss;
  db: DbPool;
  logger: Logger;
  config: Config;
}): Promise<EnqueueStats> {
  const { db, boss, logger, config } = params;
  // Only recover queued jobs that have been waiting for at least the recovery interval
  // This prevents recovering jobs that were just created
  const thresholdMs = config.analysisRecoveryIntervalMs;

  // Find and mark orphaned queued jobs atomically using CTE + UPDATE + RETURNING
  // This prevents race conditions between selection and re-queuing
  const result = await db.query<OrphanedJob>(
    `WITH orphaned_jobs AS (
      SELECT id, video_id, user_id
      FROM video_analyses
      WHERE status = 'queued'
        AND claimed_at IS NULL
        AND updated_at < NOW() - $1 * interval '1 millisecond'
      ORDER BY updated_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 50
    )
    UPDATE video_analyses va
    SET updated_at = NOW()
    FROM orphaned_jobs oj
    WHERE va.id = oj.id
    RETURNING va.id, va.video_id, va.user_id`,
    [thresholdMs]
  );

  const stats: EnqueueStats = { enqueued: 0, deduped: 0, failed: 0 };

  for (const job of result.rows) {
    try {
      // Use analysisId as singletonKey to avoid cross-video interference
      const sent = await boss.send(
        "analyze.video",
        { videoId: job.video_id, userId: job.user_id, analysisId: job.id },
        { singletonKey: `analysis.${job.id}` }
      );
      if (sent) {
        stats.enqueued += 1;
        logger.info(
          { videoId: job.video_id, analysisId: job.id },
          "Recovered orphaned queued job"
        );
      } else {
        stats.deduped += 1;
      }
    } catch (error) {
      stats.failed += 1;
      logger.error(
        { videoId: job.video_id, analysisId: job.id, err: error },
        "Failed to re-enqueue orphaned queued job"
      );
    }
  }

  if (result.rows.length > 0) {
    logger.debug(
      { selected: result.rows.length, ...stats },
      "Orphaned queued recovery stats"
    );
  }

  return stats;
}

/**
 * Recover failed jobs that are eligible for retry.
 * Uses CTE + UPDATE + RETURNING for atomic operation.
 */
async function recoverRetryableFailedJobs(params: {
  boss: PgBoss;
  db: DbPool;
  logger: Logger;
  config: Config;
}): Promise<EnqueueStats> {
  const { db, boss, logger, config } = params;
  const maxRetryCount = config.analysisMaxRetryCount;
  const retryDelayMs = config.analysisFailedRetryDelayMs;

  // Find failed jobs eligible for retry using CTE + UPDATE + RETURNING
  const result = await db.query<FailedJob>(
    `WITH retryable_jobs AS (
      SELECT id, video_id, user_id, failed_count
      FROM video_analyses
      WHERE status = 'failed'
        AND failed_count < $1
        AND updated_at < NOW() - $2 * interval '1 millisecond'
      ORDER BY updated_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 10
    )
    UPDATE video_analyses va
    SET 
      status = 'queued',
      claimed_at = NULL,
      claimed_by = NULL,
      updated_at = NOW()
    FROM retryable_jobs rj
    WHERE va.id = rj.id
    RETURNING va.id, va.video_id, va.user_id, va.failed_count`,
    [maxRetryCount, retryDelayMs]
  );

  const stats: EnqueueStats = { enqueued: 0, deduped: 0, failed: 0 };

  // Re-enqueue recovered jobs to pg-boss
  for (const job of result.rows) {
    try {
      // Use analysisId as singletonKey to avoid cross-video interference
      const sent = await boss.send(
        "analyze.video",
        { videoId: job.video_id, userId: job.user_id, analysisId: job.id },
        { singletonKey: `analysis.${job.id}` }
      );
      if (sent) {
        stats.enqueued += 1;
        logger.info(
          { videoId: job.video_id, analysisId: job.id, failedCount: job.failed_count },
          "Recovered failed job for retry"
        );
      } else {
        stats.deduped += 1;
      }
    } catch (error) {
      stats.failed += 1;
      logger.error(
        { videoId: job.video_id, analysisId: job.id, err: error },
        "Failed to re-enqueue failed job"
      );
    }
  }

  if (result.rows.length > 0) {
    logger.debug(
      { selected: result.rows.length, ...stats },
      "Failed job retry recovery stats"
    );
  }

  return stats;
}

/**
 * Main recovery function that handles all orphaned/stale/failed jobs.
 * Runs recovery functions sequentially to reduce competition and improve traceability.
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
    // Run sequentially to reduce competition and improve traceability
    const processingStats = await recoverStaleProcessingJobs(params);
    const queuedStats = await recoverOrphanedQueuedJobs(params);
    const failedStats = await recoverRetryableFailedJobs(params);

    const recoveredProcessing = processingStats.enqueued;
    const recoveredQueued = queuedStats.enqueued;
    const recoveredFailed = failedStats.enqueued;

    const totalEnqueued = recoveredProcessing + recoveredQueued + recoveredFailed;
    const totalDeduped = processingStats.deduped + queuedStats.deduped + failedStats.deduped;
    const totalFailed = processingStats.failed + queuedStats.failed + failedStats.failed;

    if (totalEnqueued > 0 || totalDeduped > 0 || totalFailed > 0) {
      logger.info(
        { 
          recoveredProcessing, 
          recoveredQueued, 
          recoveredFailed,
          totalEnqueued,
          totalDeduped,
          totalFailed,
          instanceId 
        },
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
 * Uses a running flag to prevent concurrent recovery operations.
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
  let isRunning = false;

  logger.info(
    { intervalMs, instanceId },
    "Starting job recovery scheduler"
  );

  const intervalId = setInterval(async () => {
    // Skip if previous recovery is still running
    if (isRunning) {
      logger.debug({ instanceId }, "Skipping recovery - previous operation still running");
      return;
    }

    isRunning = true;
    try {
      await recoverOrphanedJobs(params);
    } catch (error) {
      logger.error({ err: error, instanceId }, "Recovery scheduler error");
    } finally {
      isRunning = false;
    }
  }, intervalMs);

  // Return stop function
  return () => {
    logger.info({ instanceId }, "Stopping job recovery scheduler");
    clearInterval(intervalId);
  };
}
