import { createHash } from "crypto";
import type { PgBoss } from "pg-boss";
import type { DbPool } from "./db.js";

const ANALYSIS_MAX_DURATION_SEC = 3600;

export type AnalysisCandidate = {
  videoId: string;
  youtubeVideoId: string;
  durationSec: number | null;
};

export type AnalysisResult = {
  enqueued: number;
  skipped: number;
  skipReasons: Record<string, number>;
};

type VideoCandidateRow = {
  id: string;
  youtube_video_id: string;
  duration: string | null;
};

type AnalysisStatusRow = {
  video_id: string;
  status: string;
};

function parseDurationToSeconds(value?: string | null) {
  if (!value) return null;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}

export async function fetchAnalysisCandidates(
  db: DbPool,
  params: {
    userId: string;
    videoIds?: string[];
    limit?: number;
  }
): Promise<AnalysisCandidate[]> {
  if (params.videoIds && params.videoIds.length === 0) {
    return [];
  }

  const values: Array<string | number | string[]> = [params.userId];
  // Filter by status = 'active' instead of sync_status = 'synced'
  const conditions: string[] = ["user_id = $1", "status = 'active'"];

  if (params.videoIds && params.videoIds.length > 0) {
    values.push(params.videoIds);
    conditions.push(`id = any($${values.length}::uuid[])`);
  }

  const limitValue = params.videoIds?.length ? undefined : params.limit;
  const limitClause =
    typeof limitValue === "number" && Number.isFinite(limitValue) && limitValue > 0
      ? ` limit $${values.push(Math.trunc(limitValue))}`
      : "";

  const result = await db.query<VideoCandidateRow>(
    `select id, youtube_video_id, duration
     from videos
     where ${conditions.join(" and ")}
     order by created_at desc${limitClause}`,
    values
  );

  return result.rows.map((row) => ({
    videoId: row.id,
    youtubeVideoId: row.youtube_video_id,
    durationSec: parseDurationToSeconds(row.duration)
  }));
}

export async function enqueueAnalyses(params: {
  boss: PgBoss;
  db: DbPool;
  userId: string;
  prompt: string;
  model: string;
  candidates: AnalysisCandidate[];
}): Promise<AnalysisResult> {
  const skipReasons: Record<string, number> = {
    duration_exceeded: 0,
    already_queued: 0,
    analysis_in_progress: 0,
    quota_exceeded: 0
  };

  if (params.candidates.length === 0) {
    return { enqueued: 0, skipped: 0, skipReasons };
  }

  const withinDuration = params.candidates.filter((candidate) => {
    if (candidate.durationSec !== null && candidate.durationSec > ANALYSIS_MAX_DURATION_SEC) {
      skipReasons.duration_exceeded += 1;
      return false;
    }
    return true;
  });

  if (withinDuration.length === 0) {
    return { enqueued: 0, skipped: params.candidates.length, skipReasons };
  }

  // prompt_hash is removed
  const candidateIds = withinDuration.map((candidate) => candidate.videoId);
  const existingStatuses = new Map<string, string>();
  if (candidateIds.length > 0) {
    const existing = await params.db.query<AnalysisStatusRow>(
      `select video_id, status
       from video_analyses
       where video_id = any($1::uuid[])`,
      [candidateIds]
    );
    for (const row of existing.rows) {
      existingStatuses.set(row.video_id, row.status);
    }
  }

  const filtered = withinDuration.filter((candidate) => {
    const status = existingStatuses.get(candidate.videoId);
    if (status === "queued") {
      skipReasons.already_queued += 1;
      return false;
    }
    if (status === "processing") {
      skipReasons.analysis_in_progress += 1;
      return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    const skipped = params.candidates.length;
    return { enqueued: 0, skipped, skipReasons };
  }

  await params.db.query(
    `insert into user_quotas (user_id)
     values ($1)
     on conflict (user_id) do nothing`,
    [params.userId]
  );
  const quotaResult = await params.db.query(
    `select analysis_count, max_analyses
     from user_quotas
     where user_id = $1`,
    [params.userId]
  );
  const quotaRow = quotaResult.rows[0] as { analysis_count: number; max_analyses: number } | undefined;

  if (!quotaRow) {
    skipReasons.quota_exceeded += filtered.length;
    return { enqueued: 0, skipped: params.candidates.length, skipReasons };
  }

  const remaining = Math.max(0, quotaRow.max_analyses - quotaRow.analysis_count);
  const toQueue = remaining > 0 ? filtered.slice(0, remaining) : [];
  const quotaSkipped = filtered.length - toQueue.length;
  skipReasons.quota_exceeded += quotaSkipped;

  let enqueued = 0;
  for (const candidate of toQueue) {
    const queued = await params.db.query<{ id: string }>(
      `insert into video_analyses (
         video_id,
         user_id,
         analysis_text,
         model,
         usage,
         status,
         error,
         skip_reason
       ) values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (video_id)
       do update set
         user_id = excluded.user_id,
         status = excluded.status,
         error = null,
         skip_reason = null
       where video_analyses.status <> 'queued'
         and video_analyses.status <> 'processing'
       returning id`,
      [
        candidate.videoId,
        params.userId,
        "",
        params.model,
        null,
        "queued",
        null,
        null
      ]
    );

    if (!queued.rows[0]?.id) {
      const status = existingStatuses.get(candidate.videoId);
      if (status === "processing") {
        skipReasons.analysis_in_progress += 1;
      } else {
        skipReasons.already_queued += 1;
      }
      continue;
    }

    const bossJobId = await params.boss.send(
      "analyze.video",
      {
        videoId: candidate.videoId,
        userId: params.userId,
        prompt: params.prompt
      },
      { singletonKey: `analysis.${candidate.videoId}` }
    );

    if (bossJobId) {
      enqueued += 1;
    } else {
      skipReasons.already_queued += 1;
    }
  }

  if (enqueued > 0) {
    await params.db.query(
      `update user_quotas
       set analysis_count = analysis_count + $1
       where user_id = $2`,
      [enqueued, params.userId]
    );
  }

  const skipped = params.candidates.length - enqueued;
  return { enqueued, skipped, skipReasons };
}
