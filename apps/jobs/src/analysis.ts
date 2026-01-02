import { createHash } from "crypto";
import type { PgBoss } from "pg-boss";
import type { DbPool } from "./db.js";

const ANALYSIS_MAX_DURATION_SEC = 3600;

export type AnalysisCandidate = {
  videoId: string;
  youtubeVideoId: string;
  durationSec: number;
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

function parseDurationToSeconds(value?: string | null) {
  if (!value) return 0;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return 0;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}

export async function fetchAnalysisCandidates(
  db: DbPool,
  params: {
    playlistId: string;
    videoIds?: string[];
    limit?: number;
  }
): Promise<AnalysisCandidate[]> {
  if (params.videoIds && params.videoIds.length === 0) {
    return [];
  }

  const values: Array<string | number | string[]> = [params.playlistId];
  const conditions: string[] = ["playlist_id = $1", "sync_status = 'synced'"];

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
  playlistId: string;
  prompt: string;
  candidates: AnalysisCandidate[];
}): Promise<AnalysisResult> {
  const skipReasons: Record<string, number> = {
    duration_exceeded: 0,
    analysis_exists: 0,
    quota_exceeded: 0
  };

  if (params.candidates.length === 0) {
    return { enqueued: 0, skipped: 0, skipReasons };
  }

  const withinDuration = params.candidates.filter((candidate) => {
    if (candidate.durationSec > ANALYSIS_MAX_DURATION_SEC) {
      skipReasons.duration_exceeded += 1;
      return false;
    }
    return true;
  });

  if (withinDuration.length === 0) {
    return { enqueued: 0, skipped: params.candidates.length, skipReasons };
  }

  const promptHash = createHash("sha256").update(params.prompt).digest("hex");
  const candidateIds = withinDuration.map((candidate) => candidate.videoId);
  const existing = await params.db.query(
    `select video_id
     from video_analyses
     where video_id = any($1::uuid[])
       and prompt_hash = $2`,
    [candidateIds, promptHash]
  );
  const existingSet = new Set(existing.rows.map((row: { video_id: string }) => row.video_id));

  const filtered = withinDuration.filter((candidate) => {
    if (existingSet.has(candidate.videoId)) {
      skipReasons.analysis_exists += 1;
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
    const bossJobId = await params.boss.send(
      "analyze.video",
      {
        videoId: candidate.videoId,
        playlistId: params.playlistId,
        userId: params.userId,
        prompt: params.prompt,
        promptHash
      },
      { singletonKey: `analysis.${candidate.videoId}.${promptHash}` }
    );

    if (bossJobId) {
      enqueued += 1;
    } else {
      skipReasons.analysis_exists += 1;
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
