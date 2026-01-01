import { createHash } from "crypto";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Logger } from "pino";
import { captureException } from "./sentry";
import type { Config } from "./config";
import {
  getPlaylistWithAccount,
  insertJobRun,
  insertSyncRun,
  reservePlaylistsForSync,
  updateJobRunById,
  updatePlaylistEntryStatus,
  updatePlaylistLastSyncedAt,
  updateSyncRun,
  type DbPool
} from "./db";
import { buildSyncPlaylistJobOptions } from "./queue";
import { fetchPlaylistItems, fetchVideoDetails, type PlaylistItem, YouTubeApiError } from "./youtube";

const ANALYSIS_MAX_DURATION_SEC = 3600;
const VIDEO_UPSERT_CHUNK_SIZE = 100;

type SyncPlaylistPayload = {
  syncRunId: string;
  playlistId: string;
  userId?: string | null;
  jobRunId: string;
};

type UpsertVideo = {
  youtubeVideoId: string;
  title: string | null;
  description: string | null;
  publishedAt: string | null;
  thumbnailUrl: string | null;
  duration: string | null;
  raw: Record<string, unknown> | null;
};

type AnalysisCandidate = {
  videoId: string;
  youtubeVideoId: string;
  durationSec: number;
};

type AnalysisResult = {
  enqueued: number;
  skipped: number;
  skipReasons: Record<string, number>;
};

function pickThumbnailUrl(thumbnails?: Record<string, { url?: string }>) {
  const order = ["maxres", "standard", "high", "medium", "default"];
  for (const key of order) {
    const url = thumbnails?.[key]?.url;
    if (url) return url;
  }
  return null;
}

function parseDurationToSeconds(value?: string | null) {
  if (!value) return 0;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return 0;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function normalizeJobList<T>(jobs: JobWithMetadata<T>[] | JobWithMetadata<T>) {
  return Array.isArray(jobs) ? jobs : [jobs];
}

async function upsertVideos(
  db: DbPool,
  playlistId: string,
  items: UpsertVideo[],
  seenAt: Date
) {
  const map = new Map<string, string>();

  for (let i = 0; i < items.length; i += VIDEO_UPSERT_CHUNK_SIZE) {
    const chunk = items.slice(i, i + VIDEO_UPSERT_CHUNK_SIZE);
    if (chunk.length === 0) continue;

    const values: Array<string | Date | null | Record<string, unknown>> = [];
    const placeholders = chunk.map((item, index) => {
      const offset = index * 11;
      values.push(
        playlistId,
        item.youtubeVideoId,
        item.title,
        item.description,
        item.publishedAt,
        item.thumbnailUrl,
        item.duration,
        item.raw,
        "synced",
        null,
        seenAt
      );
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11})`;
    });

    const result = await db.query(
      `insert into videos (
         playlist_id,
         youtube_video_id,
         title,
         description,
         published_at,
         thumbnail_url,
         duration,
         raw,
         sync_status,
         removed_at,
         last_seen_at
       ) values ${placeholders.join(", ")}
       on conflict (playlist_id, youtube_video_id)
       do update set
         title = excluded.title,
         description = excluded.description,
         published_at = excluded.published_at,
         thumbnail_url = excluded.thumbnail_url,
         duration = excluded.duration,
         raw = excluded.raw,
         sync_status = 'synced',
         removed_at = null,
         last_seen_at = excluded.last_seen_at
       returning id, youtube_video_id`,
      values
    );

    for (const row of result.rows as Array<{ id: string; youtube_video_id: string }>) {
      map.set(row.youtube_video_id, row.id);
    }
  }

  return map;
}

async function markRemovedVideos(db: DbPool, playlistId: string, videoIds: string[], removedAt: Date) {
  const result = await db.query(
    `update videos
     set sync_status = 'removed',
         removed_at = $2
     where playlist_id = $1
       and sync_status = 'synced'
       and not (youtube_video_id = any($3::text[]))`,
    [playlistId, removedAt, videoIds]
  );

  return result.rowCount ?? 0;
}

async function fetchExistingVideoStatuses(db: DbPool, playlistId: string, videoIds: string[]) {
  if (videoIds.length === 0) return new Map<string, string>();

  const result = await db.query(
    `select youtube_video_id, sync_status
     from videos
     where playlist_id = $1
       and youtube_video_id = any($2::text[])`,
    [playlistId, videoIds]
  );

  const map = new Map<string, string>();
  for (const row of result.rows as Array<{ youtube_video_id: string; sync_status: string }>) {
    map.set(row.youtube_video_id, row.sync_status);
  }
  return map;
}

async function enqueueAnalyses(params: {
  boss: PgBoss;
  db: DbPool;
  userId: string;
  playlistId: string;
  prompt: string;
  candidates: AnalysisCandidate[];
}) : Promise<AnalysisResult> {
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
      "analyze:video",
      {
        videoId: candidate.videoId,
        playlistId: params.playlistId,
        userId: params.userId,
        prompt: params.prompt,
        promptHash
      },
      { singletonKey: `analysis:${candidate.videoId}:${promptHash}` }
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

export async function registerWorkers(params: {
  boss: PgBoss;
  db: DbPool;
  logger: Logger;
  config: Config;
}) {
  const { boss, db, logger, config } = params;

  await boss.work("kickoff", async (job) => {
    const kickoffSource = (job.data as { source?: string } | null)?.source ?? "schedule";
    const requestedBy = (job.data as { requestedBy?: string } | null)?.requestedBy ?? null;

    const syncRun = await insertSyncRun(db, {
      kickoffSource,
      meta: { kickoffJobId: job.id, requestedBy }
    });

    await updateSyncRun(db, syncRun.id, { status: "running", startedAt: new Date() });

    try {
      const playlists = await reservePlaylistsForSync(db, {
        limit: config.kickoffBatchLimit,
        defaultIntervalSec: config.syncIntervalSec
      });

      let enqueued = 0;
      let skipped = 0;

      for (const playlist of playlists) {
        const jobRun = await insertJobRun(db, {
          syncRunId: syncRun.id,
          jobName: "sync:playlist",
          status: "queued",
          playlistId: playlist.id,
          userId: playlist.user_id
        });

        const bossJobId = await boss.send(
          "sync:playlist",
          {
            syncRunId: syncRun.id,
            playlistId: playlist.id,
            userId: playlist.user_id,
            jobRunId: jobRun.id
          },
          buildSyncPlaylistJobOptions(playlist.id)
        );

        if (bossJobId) {
          await updateJobRunById(db, jobRun.id, { bossJobId });
          enqueued += 1;
        } else {
          await updateJobRunById(db, jobRun.id, {
            status: "skipped",
            finishedAt: new Date(),
            error: "deduped",
            result: { reason: "deduped" }
          });
          skipped += 1;
        }
      }

      await updateSyncRun(db, syncRun.id, {
        status: "succeeded",
        finishedAt: new Date(),
        meta: {
          kickoffJobId: job.id,
          requestedBy,
          kickoffSource,
          batchLimit: config.kickoffBatchLimit,
          enqueued,
          skipped
        }
      });

      logger.info({ syncRunId: syncRun.id, enqueued, skipped }, "Kickoff enqueued playlist sync jobs");
      return { syncRunId: syncRun.id, enqueued, skipped };
    } catch (error) {
      await updateSyncRun(db, syncRun.id, {
        status: "failed",
        finishedAt: new Date(),
        meta: {
          kickoffJobId: job.id,
          requestedBy,
          kickoffSource,
          error: error instanceof Error ? error.message : "unknown_error"
        }
      });
      captureException(error);
      logger.error({ syncRunId: syncRun.id, err: error }, "Kickoff failed");
      throw error;
    }
  });

  await boss.work("sync:playlist", { includeMetadata: true }, async (jobs) => {
    const jobList = normalizeJobList(jobs);

    for (const job of jobList) {
      const payload = job.data as SyncPlaylistPayload | null;
      const syncRunId = payload?.syncRunId;
      const playlistId = payload?.playlistId;
      const jobRunId = payload?.jobRunId;
      const payloadUserId = payload?.userId ?? null;

      if (!syncRunId || !playlistId || !jobRunId) {
        throw new Error("sync:playlist missing required payload");
      }

      const attempt = typeof job.retryCount === "number" ? job.retryCount + 1 : 1;
      await updateJobRunById(db, jobRunId, {
        status: "running",
        startedAt: new Date(),
        attempt,
        error: null,
        result: null
      });

      const playlist = await getPlaylistWithAccount(db, playlistId);
      if (!playlist) {
        await updateJobRunById(db, jobRunId, {
          status: "skipped",
          finishedAt: new Date(),
          error: "playlist_missing",
          result: { reason: "playlist_missing" }
        });
        continue;
      }

      if (playlist.entry_status !== "active") {
        await updateJobRunById(db, jobRunId, {
          status: "skipped",
          finishedAt: new Date(),
          error: "playlist_inactive",
          result: { reason: "playlist_inactive" }
        });
        continue;
      }

      if (!playlist.access_token) {
        await updatePlaylistEntryStatus(db, playlist.id, "auth_invalid");
        await updateJobRunById(db, jobRunId, {
          status: "skipped",
          finishedAt: new Date(),
          error: "auth_invalid",
          result: { reason: "auth_invalid" }
        });
        continue;
      }

      const playlistUserId = playlist.user_id ?? payloadUserId;

      const startedAt = Date.now();
      try {
        const { items } = await fetchPlaylistItems(playlist.access_token, playlist.playlist_id);
        const idMap = new Map<string, PlaylistItem>();
        const videoIds: string[] = [];

        for (const item of items) {
          const videoId = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
          if (!videoId || idMap.has(videoId)) continue;
          idMap.set(videoId, item);
          videoIds.push(videoId);
        }

        const videoDetails = await fetchVideoDetails(playlist.access_token, videoIds);
        const seenAt = new Date();

        const existingStatuses = await fetchExistingVideoStatuses(db, playlist.id, videoIds);
        const newVideoIds = videoIds.filter((id) => {
          const status = existingStatuses.get(id);
          return !status || status !== "synced";
        });

        const upsertRows: UpsertVideo[] = videoIds.map((videoId) => {
          const item = idMap.get(videoId);
          const snippet = item?.snippet;
          const details = videoDetails.get(videoId);
          return {
            youtubeVideoId: videoId,
            title: snippet?.title ?? null,
            description: snippet?.description ?? null,
            publishedAt: snippet?.publishedAt ?? null,
            thumbnailUrl: pickThumbnailUrl(snippet?.thumbnails),
            duration: details?.contentDetails?.duration ?? null,
            raw: {
              playlistItem: item ?? null,
              video: details ?? null
            }
          };
        });

        const videoIdMap = await upsertVideos(db, playlist.id, upsertRows, seenAt);
        const removedCount = await markRemovedVideos(db, playlist.id, videoIds, seenAt);
        await updatePlaylistLastSyncedAt(db, playlist.id, seenAt);

        const analysisCandidates: AnalysisCandidate[] = newVideoIds
          .map((youtubeVideoId) => {
            const videoId = videoIdMap.get(youtubeVideoId);
            if (!videoId) return null;
            const duration = videoDetails.get(youtubeVideoId)?.contentDetails?.duration ?? null;
            return {
              videoId,
              youtubeVideoId,
              durationSec: parseDurationToSeconds(duration)
            };
          })
          .filter((candidate): candidate is AnalysisCandidate => Boolean(candidate));

        let analysisResult: AnalysisResult = {
          enqueued: 0,
          skipped: 0,
          skipReasons: {}
        };
        if (playlistUserId) {
          analysisResult = await enqueueAnalyses({
            boss,
            db,
            userId: playlistUserId,
            playlistId: playlist.id,
            prompt: playlist.analysis_prompt,
            candidates: analysisCandidates
          });
        } else if (analysisCandidates.length > 0) {
          analysisResult = {
            enqueued: 0,
            skipped: analysisCandidates.length,
            skipReasons: { missing_user: analysisCandidates.length }
          };
        }

        const durationMs = Date.now() - startedAt;
        const result = {
          fetchedCount: videoIds.length,
          newCount: newVideoIds.length,
          removedCount,
          durationMs,
          etagHit: false,
          analysesEnqueued: analysisResult.enqueued,
          analysesSkipped: analysisResult.skipped,
          analysisSkipReasons: analysisResult.skipReasons
        };

        await updateJobRunById(db, jobRunId, {
          status: "succeeded",
          finishedAt: new Date(),
          result
        });
        logger.info(
          { syncRunId, jobRunId, playlistId, result },
          "Playlist sync completed"
        );
      } catch (error) {
        if (error instanceof YouTubeApiError) {
          if (error.status === 404) {
            await updatePlaylistEntryStatus(db, playlist.id, "lost");
            await updateJobRunById(db, jobRunId, {
              status: "skipped",
              finishedAt: new Date(),
              error: "playlist_missing",
              result: { httpStatus: error.status, reason: error.reason }
            });
            continue;
          }

          if (error.status === 401 || error.status === 403) {
            await updatePlaylistEntryStatus(db, playlist.id, "auth_invalid");
            await updateJobRunById(db, jobRunId, {
              status: "skipped",
              finishedAt: new Date(),
              error: "auth_invalid",
              result: { httpStatus: error.status, reason: error.reason }
            });
            continue;
          }

          if (error.status === 429 || error.status >= 500) {
            await updateJobRunById(db, jobRunId, {
              status: "failed",
              finishedAt: new Date(),
              error: error.message,
              result: { httpStatus: error.status, reason: error.reason }
            });
            captureException(error);
            logger.error({ syncRunId, jobRunId, playlistId, err: error }, "Playlist sync retryable error");
            throw error;
          }

          await updateJobRunById(db, jobRunId, {
            status: "failed",
            finishedAt: new Date(),
            error: error.message,
            result: { httpStatus: error.status, reason: error.reason }
          });
          continue;
        }

        await updateJobRunById(db, jobRunId, {
          status: "failed",
          finishedAt: new Date(),
          error: error instanceof Error ? error.message : "unknown error"
        });
        captureException(error);
        logger.error({ syncRunId, jobRunId, playlistId, err: error }, "Playlist sync failed");
        throw error;
      }
    }
  });
}
