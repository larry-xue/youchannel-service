import { Pool } from "pg";
import type { JobRunStatus, SyncRunStatus } from "@youchannel/core";

export type DbPool = Pool;

export function createDbPool(databaseUrl: string) {
  return new Pool({ connectionString: databaseUrl });
}

export async function insertSyncRun(pool: DbPool, params: { kickoffSource: string; meta?: Record<string, unknown> }) {
  const result = await pool.query(
    `insert into sync_runs (kickoff_source, status, meta)
     values ($1, $2, $3)
     returning *`,
    [params.kickoffSource, "queued", params.meta ?? {}]
  );

  return result.rows[0];
}

export async function updateSyncRun(
  pool: DbPool,
  id: string,
  params: {
    status?: SyncRunStatus;
    startedAt?: Date;
    finishedAt?: Date;
  }
) {
  const updates: string[] = [];
  const values: Array<string | Date> = [];
  let index = 1;

  if (params.status) {
    updates.push(`status = $${index++}`);
    values.push(params.status);
  }
  if (params.startedAt) {
    updates.push(`started_at = $${index++}`);
    values.push(params.startedAt);
  }
  if (params.finishedAt) {
    updates.push(`finished_at = $${index++}`);
    values.push(params.finishedAt);
  }

  if (updates.length === 0) {
    return null;
  }

  values.push(id);

  const result = await pool.query(
    `update sync_runs set ${updates.join(", ")}
     where id = $${index}
     returning *`,
    values
  );

  return result.rows[0];
}

export async function insertJobRun(
  pool: DbPool,
  params: {
    syncRunId: string;
    jobName: string;
    bossJobId?: string | null;
    status?: JobRunStatus;
    attempt?: number;
  }
) {
  const result = await pool.query(
    `insert into job_runs (sync_run_id, job_name, boss_job_id, status, attempt)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [
      params.syncRunId,
      params.jobName,
      params.bossJobId ?? null,
      params.status ?? "queued",
      params.attempt ?? 1
    ]
  );

  return result.rows[0];
}

export async function updateJobRunByBossId(
  pool: DbPool,
  bossJobId: string,
  params: {
    status?: JobRunStatus;
    startedAt?: Date;
    finishedAt?: Date;
    error?: string | null;
    result?: Record<string, unknown> | null;
  }
) {
  const updates: string[] = [];
  const values: Array<string | Date | Record<string, unknown> | null> = [];
  let index = 1;

  if (params.status) {
    updates.push(`status = $${index++}`);
    values.push(params.status);
  }
  if (params.startedAt) {
    updates.push(`started_at = $${index++}`);
    values.push(params.startedAt);
  }
  if (params.finishedAt) {
    updates.push(`finished_at = $${index++}`);
    values.push(params.finishedAt);
  }
  if (params.error !== undefined) {
    updates.push(`error = $${index++}`);
    values.push(params.error);
  }
  if (params.result !== undefined) {
    updates.push(`result = $${index++}`);
    values.push(params.result);
  }

  if (updates.length === 0) {
    return null;
  }

  values.push(bossJobId);

  const result = await pool.query(
    `update job_runs set ${updates.join(", ")}
     where boss_job_id = $${index}
     returning *`,
    values
  );

  return result.rows[0];
}

export async function listSyncRuns(pool: DbPool, limit = 50) {
  const result = await pool.query(
    `select * from sync_runs order by created_at desc limit $1`,
    [limit]
  );

  return result.rows;
}

export async function listJobRuns(pool: DbPool, params: { syncRunId?: string; limit?: number }) {
  const limit = params.limit ?? 50;
  if (params.syncRunId) {
    const result = await pool.query(
      `select * from job_runs where sync_run_id = $1 order by created_at desc limit $2`,
      [params.syncRunId, limit]
    );
    return result.rows;
  }

  const result = await pool.query(
    `select * from job_runs order by created_at desc limit $1`,
    [limit]
  );
  return result.rows;
}