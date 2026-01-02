import { Pool } from "pg";
import type { JobRunStatus, SyncRunStatus } from "@youchannel/core";

export type DbPool = Pool;

export type PlaylistSyncTarget = {
  id: string;
  user_id: string;
  playlist_id: string;
  youtube_account_id: string | null;
  sync_interval_sec: number | null;
};

export type PlaylistWithAccount = {
  id: string;
  user_id: string;
  playlist_id: string;
  entry_status: string;
  analysis_prompt: string;
  youtube_account_id: string | null;
  access_token: string | null;
};

export function createDbPool(databaseUrl: string) {
  return new Pool({ connectionString: databaseUrl });
}

export async function reservePlaylistsForSync(
  pool: DbPool,
  params: {
    limit: number;
    defaultIntervalSec: number;
    jitterRatio?: number;
    jitterMaxSec?: number;
  }
) {
  const client = await pool.connect();
  const jitterRatio = params.jitterRatio ?? 0.1;
  const jitterMaxSec = params.jitterMaxSec ?? 300;

  try {
    await client.query("begin");

    const result = await client.query<PlaylistSyncTarget>(
      `select id, user_id, playlist_id, youtube_account_id, sync_interval_sec
       from playlists
       where entry_status = 'active'
         and (next_sync_at is null or next_sync_at <= timezone('utc'::text, now()))
       order by coalesce(next_sync_at, '1970-01-01'::timestamptz) asc
       for update skip locked
       limit $1`,
      [params.limit]
    );

    for (const row of result.rows) {
      const intervalSec = row.sync_interval_sec ?? params.defaultIntervalSec;
      const jitterWindow = Math.min(Math.floor(intervalSec * jitterRatio), jitterMaxSec);
      const jitterSec = jitterWindow > 0 ? Math.floor(Math.random() * jitterWindow) : 0;
      const totalSec = intervalSec + jitterSec;
      await client.query(
        `update playlists
         set next_sync_at = timezone('utc'::text, now()) + ($1::int * interval '1 second')
         where id = $2`,
        [totalSec, row.id]
      );
    }

    await client.query("commit");
    return result.rows;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function getPlaylistWithAccount(pool: DbPool, playlistId: string) {
  const result = await pool.query<PlaylistWithAccount>(
    `select p.id,
            p.user_id,
            p.playlist_id,
            p.entry_status,
            p.analysis_prompt,
            p.youtube_account_id,
            ya.access_token
     from playlists p
     left join youtube_accounts ya on ya.id = p.youtube_account_id
     where p.id = $1`,
    [playlistId]
  );

  return result.rows[0] ?? null;
}

export async function updatePlaylistEntryStatus(
  pool: DbPool,
  playlistId: string,
  entryStatus: string
) {
  await pool.query(
    `update playlists set entry_status = $1 where id = $2`,
    [entryStatus, playlistId]
  );
}

export async function updatePlaylistLastSyncedAt(
  pool: DbPool,
  playlistId: string,
  lastSyncedAt: Date
) {
  await pool.query(
    `update playlists set last_synced_at = $1 where id = $2`,
    [lastSyncedAt, playlistId]
  );
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
    meta?: Record<string, unknown>;
  }
) {
  const updates: string[] = [];
  const values: Array<string | Date | Record<string, unknown>> = [];
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
  if (params.meta) {
    updates.push(`meta = $${index++}`);
    values.push(params.meta);
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
    playlistId?: string | null;
    userId?: string | null;
  }
) {
  const result = await pool.query(
    `insert into job_runs (sync_run_id, job_name, boss_job_id, status, attempt, playlist_id, user_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning *`,
    [
      params.syncRunId,
      params.jobName,
      params.bossJobId ?? null,
      params.status ?? "queued",
      params.attempt ?? 1,
      params.playlistId ?? null,
      params.userId ?? null
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
    attempt?: number;
  }
) {
  const updates: string[] = [];
  const values: Array<string | Date | Record<string, unknown> | null | number> = [];
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
  if (params.attempt !== undefined) {
    updates.push(`attempt = $${index++}`);
    values.push(params.attempt);
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

export async function updateJobRunById(
  pool: DbPool,
  id: string,
  params: {
    status?: JobRunStatus;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    error?: string | null;
    result?: Record<string, unknown> | null;
    attempt?: number;
    bossJobId?: string | null;
  }
) {
  const updates: string[] = [];
  const values: Array<string | Date | Record<string, unknown> | null | number> = [];
  let index = 1;

  if (params.status) {
    updates.push(`status = $${index++}`);
    values.push(params.status);
  }
  if (params.startedAt !== undefined) {
    updates.push(`started_at = $${index++}`);
    values.push(params.startedAt);
  }
  if (params.finishedAt !== undefined) {
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
  if (params.attempt !== undefined) {
    updates.push(`attempt = $${index++}`);
    values.push(params.attempt);
  }
  if (params.bossJobId !== undefined) {
    updates.push(`boss_job_id = $${index++}`);
    values.push(params.bossJobId);
  }

  if (updates.length === 0) {
    return null;
  }

  values.push(id);

  const result = await pool.query(
    `update job_runs set ${updates.join(", ")}
     where id = $${index}
     returning *`,
    values
  );

  return result.rows[0];
}

export async function getJobRunById(pool: DbPool, id: string) {
  const result = await pool.query(
    `select * from job_runs where id = $1`,
    [id]
  );

  return result.rows[0] ?? null;
}

export async function listSyncRuns(pool: DbPool, limit = 50) {
  const result = await pool.query(
    `select sr.*,
            count(jr.id) as job_total,
            count(jr.id) filter (where jr.status = 'queued') as job_queued,
            count(jr.id) filter (where jr.status = 'running') as job_running,
            count(jr.id) filter (where jr.status = 'succeeded') as job_succeeded,
            count(jr.id) filter (where jr.status = 'failed') as job_failed,
            count(jr.id) filter (where jr.status = 'skipped') as job_skipped,
            min(jr.started_at) as job_started_at,
            max(jr.finished_at) as job_finished_at
     from sync_runs sr
     left join job_runs jr on jr.sync_run_id = sr.id
     group by sr.id
     order by sr.created_at desc
     limit $1`,
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
