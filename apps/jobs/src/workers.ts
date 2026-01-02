import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Logger } from "pino";
import { captureException } from "./sentry.js";
import type { Config } from "./config.js";
import {
  getPlaylistWithAccount,
  insertJobRun,
  insertSyncRun,
  reservePlaylistsForSync,
  updateJobRunById,
  updatePlaylistEntryStatus,
  updatePlaylistLastSyncedAt,
  updateSyncRun,
  updateYoutubeAccountTokens,
  type DbPool
} from "./db.js";
import { buildSyncPlaylistJobOptions } from "./queue.js";
import {
  fetchPlaylistItems,
  fetchVideoDetails,
  refreshAccessToken,
  type PlaylistItem,
  OAuthTokenError,
  YouTubeApiError
} from "./youtube.js";

const VIDEO_UPSERT_CHUNK_SIZE = 100;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;
const ANALYSIS_MAX_DURATION_SEC = 3600;
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

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

type AnalyzeVideoPayload = {
  videoId: string;
  playlistId: string;
  userId: string;
  prompt: string;
  promptHash: string;
};

type VideoAnalysisTarget = {
  id: string;
  playlist_id: string;
  user_id: string;
  youtube_video_id: string;
  title: string | null;
  description: string | null;
  duration: string | null;
  sync_status: string;
  raw: Record<string, unknown> | null;
};

type AnalysisRecord = {
  id: string;
  status: string;
};

function pickThumbnailUrl(thumbnails?: Record<string, { url?: string }>) {
  const order = ["maxres", "standard", "high", "medium", "default"];
  for (const key of order) {
    const url = thumbnails?.[key]?.url;
    if (url) return url;
  }
  return null;
}

function normalizeJobList<T>(jobs: JobWithMetadata<T>[] | JobWithMetadata<T>) {
  return Array.isArray(jobs) ? jobs : [jobs];
}

function shouldRefreshAccessToken(accessToken: string | null, expiresAt: string | Date | null) {
  if (!accessToken) return true;
  if (!expiresAt) return false;
  const expiresMs = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  if (Number.isNaN(expiresMs)) return false;
  return expiresMs <= Date.now() + ACCESS_TOKEN_REFRESH_SKEW_MS;
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

function buildAnalysisInput(video: VideoAnalysisTarget, prompt: string) {
  const lines: string[] = ["Instruction:", prompt, "", "Video metadata:"];
  if (video.title) lines.push(`Title: ${video.title}`);
  if (video.description) lines.push(`Description: ${video.description}`);
  if (video.duration) lines.push(`Duration: ${video.duration}`);
  lines.push(`YouTube ID: ${video.youtube_video_id}`);
  return lines.join("\n");
}

async function fetchVideoForAnalysis(db: DbPool, videoId: string) {
  const result = await db.query<VideoAnalysisTarget>(
    `select v.id,
            v.playlist_id,
            p.user_id,
            v.youtube_video_id,
            v.title,
            v.description,
            v.duration,
            v.sync_status,
            v.raw
     from videos v
     join playlists p on p.id = v.playlist_id
     where v.id = $1`,
    [videoId]
  );

  return result.rows[0] ?? null;
}

async function fetchAnalysisRecord(db: DbPool, videoId: string, promptHash: string) {
  const result = await db.query<AnalysisRecord>(
    `select id, status
     from video_analyses
     where video_id = $1
       and prompt_hash = $2
     limit 1`,
    [videoId, promptHash]
  );
  return result.rows[0] ?? null;
}

async function upsertVideoAnalysis(db: DbPool, params: {
  videoId: string;
  playlistId: string;
  userId: string;
  prompt: string;
  promptHash: string;
  status: string;
  model: string;
  analysisText: string;
  usage: Record<string, unknown> | null;
  error: string | null;
  skipReason: string | null;
}) {
  const result = await db.query<{ id: string }>(
    `insert into video_analyses (
       video_id,
       playlist_id,
       user_id,
       prompt,
       prompt_hash,
       analysis_text,
       model,
       usage,
       status,
       error,
       skip_reason
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (video_id, prompt_hash)
     do update set
       analysis_text = excluded.analysis_text,
       model = excluded.model,
       usage = excluded.usage,
       status = excluded.status,
       error = excluded.error,
       skip_reason = excluded.skip_reason
     returning id`,
    [
      params.videoId,
      params.playlistId,
      params.userId,
      params.prompt,
      params.promptHash,
      params.analysisText,
      params.model,
      params.usage,
      params.status,
      params.error,
      params.skipReason
    ]
  );

  return result.rows[0]?.id ?? null;
}

async function updateVideoAnalysis(db: DbPool, params: {
  id: string;
  status: string;
  model: string;
  analysisText: string;
  usage: Record<string, unknown> | null;
  error: string | null;
  skipReason: string | null;
}) {
  await db.query(
    `update video_analyses
     set analysis_text = $1,
         model = $2,
         usage = $3,
         status = $4,
         error = $5,
         skip_reason = $6
     where id = $7`,
    [
      params.analysisText,
      params.model,
      params.usage,
      params.status,
      params.error,
      params.skipReason,
      params.id
    ]
  );
}

type GeminiGenerateResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  usageMetadata?: Record<string, unknown>;
};

async function generateGeminiAnalysis(params: {
  apiKey: string;
  model: string;
  content: string;
}) {
  const url = new URL(`${GEMINI_API_BASE}/models/${params.model}:generateContent`);
  url.searchParams.set("key", params.apiKey);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: params.content }]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 512
      }
    })
  });

  if (!response.ok) {
    const raw = await response.text();
    let message = response.statusText || "Gemini API error";
    if (raw) {
      try {
        const payload = JSON.parse(raw) as { error?: { message?: string } };
        message = payload?.error?.message ?? raw;
      } catch {
        message = raw;
      }
    }
    throw new Error(`Gemini API error (${response.status}): ${message}`);
  }

  const payload = (await response.json()) as GeminiGenerateResponse;
  const text = payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Gemini API returned empty content");
  }

  return {
    text,
    usage: payload.usageMetadata ?? null
  };
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

export async function registerWorkers(params: {
  boss: PgBoss;
  db: DbPool;
  logger: Logger;
  config: Config;
}) {
  const { boss, db, logger, config } = params;

  // Ensure queues exist before registering workers
  await boss.createQueue("kickoff");
  await boss.createQueue("sync.playlist");
  await boss.createQueue("analyze.video");

  await boss.work("kickoff", async (job: any) => {
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
          jobName: "sync.playlist",
          status: "queued",
          playlistId: playlist.id,
          userId: playlist.user_id
        });

        const bossJobId = await boss.send(
          "sync.playlist",
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

  await boss.work("sync.playlist", { includeMetadata: true }, async (jobs) => {
    const jobList = normalizeJobList(jobs);

    for (const job of jobList) {
      const payload = job.data as SyncPlaylistPayload | null;
      const syncRunId = payload?.syncRunId;
      const playlistId = payload?.playlistId;
      const jobRunId = payload?.jobRunId;

      if (!syncRunId || !playlistId || !jobRunId) {
        throw new Error("sync.playlist missing required payload");
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

      let accessToken = playlist.access_token;
      const needsRefresh = shouldRefreshAccessToken(accessToken, playlist.expires_at);

      if (needsRefresh && playlist.refresh_token) {
        const clientId = config.youtubeOAuthClientId;
        const clientSecret = config.youtubeOAuthClientSecret;

        if (!clientId || !clientSecret) {
          await updateJobRunById(db, jobRunId, {
            status: "failed",
            finishedAt: new Date(),
            error: "oauth_config_missing",
            result: { reason: "oauth_config_missing" }
          });
          logger.error({ syncRunId, jobRunId, playlistId }, "Missing OAuth client config for refresh");
          continue;
        }

        try {
          const refreshed = await refreshAccessToken({
            clientId,
            clientSecret,
            refreshToken: playlist.refresh_token
          });

          const tokenUpdates: {
            accessToken: string;
            refreshToken?: string | null;
            expiresAt?: Date | null;
            scope?: string | null;
            tokenType?: string | null;
          } = { accessToken: refreshed.access_token };

          const expiresIn = typeof refreshed.expires_in === "number" ? refreshed.expires_in : Number.NaN;
          if (Number.isFinite(expiresIn)) {
            tokenUpdates.expiresAt = new Date(Date.now() + expiresIn * 1000);
          }

          if (refreshed.refresh_token) {
            tokenUpdates.refreshToken = refreshed.refresh_token;
          }
          if (refreshed.scope !== undefined) {
            tokenUpdates.scope = refreshed.scope ?? null;
          }
          if (refreshed.token_type !== undefined) {
            tokenUpdates.tokenType = refreshed.token_type ?? null;
          }

          if (playlist.youtube_account_id) {
            await updateYoutubeAccountTokens(db, playlist.youtube_account_id, tokenUpdates);
          }

          accessToken = refreshed.access_token;
          logger.info(
            { syncRunId, jobRunId, playlistId, youtubeAccountId: playlist.youtube_account_id },
            "YouTube access token refreshed"
          );
        } catch (error) {
          const finishedAt = new Date();
          if (error instanceof OAuthTokenError) {
            await updateJobRunById(db, jobRunId, {
              status: "failed",
              finishedAt,
              error: "oauth_refresh_failed",
              result: {
                httpStatus: error.status,
                reason: error.error ?? error.message,
                description: error.errorDescription
              }
            });

            if (error.status === 429 || (typeof error.status === "number" && error.status >= 500)) {
              captureException(error);
              logger.error(
                { syncRunId, jobRunId, playlistId, err: error },
                "OAuth refresh retryable error"
              );
              throw error;
            }

            logger.warn(
              { syncRunId, jobRunId, playlistId, err: error },
              "OAuth refresh failed"
            );
            continue;
          }

          await updateJobRunById(db, jobRunId, {
            status: "failed",
            finishedAt,
            error: "oauth_refresh_failed",
            result: { reason: error instanceof Error ? error.message : "unknown_error" }
          });
          captureException(error);
          logger.error({ syncRunId, jobRunId, playlistId, err: error }, "OAuth refresh failed");
          throw error;
        }
      }

      if (!accessToken) {
        await updateJobRunById(db, jobRunId, {
          status: "skipped",
          finishedAt: new Date(),
          error: "auth_missing",
          result: { reason: "auth_missing" }
        });
        continue;
      }

      const startedAt = Date.now();
      try {
        const { items } = await fetchPlaylistItems(accessToken, playlist.playlist_id);
        const idMap = new Map<string, PlaylistItem>();
        const videoIds: string[] = [];

        for (const item of items) {
          const videoId = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
          if (!videoId || idMap.has(videoId)) continue;
          idMap.set(videoId, item);
          videoIds.push(videoId);
        }

        const videoDetails = await fetchVideoDetails(accessToken, videoIds);
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

        await upsertVideos(db, playlist.id, upsertRows, seenAt);
        const removedCount = await markRemovedVideos(db, playlist.id, videoIds, seenAt);
        await updatePlaylistLastSyncedAt(db, playlist.id, seenAt);

        const durationMs = Date.now() - startedAt;
        const result = {
          fetchedCount: videoIds.length,
          newCount: newVideoIds.length,
          removedCount,
          durationMs,
          etagHit: false,
          analysesEnqueued: 0,
          analysesSkipped: 0,
          analysisSkipReasons: {}
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

  await boss.work("analyze.video", async (job: any) => {
    const payload = job.data as AnalyzeVideoPayload | null;
    const videoId = payload?.videoId;
    const playlistId = payload?.playlistId;
    const userId = payload?.userId;
    const prompt = payload?.prompt;
    const promptHash = payload?.promptHash;

    if (!videoId || !playlistId || !userId || !prompt || !promptHash) {
      throw new Error("analyze.video missing required payload");
    }

    const video = await fetchVideoForAnalysis(db, videoId);
    if (!video) {
      logger.warn({ videoId, playlistId, userId, jobId: job.id }, "Analyze video skipped; video missing");
      return { status: "skipped", reason: "video_missing" };
    }

    if (video.playlist_id !== playlistId || video.user_id !== userId) {
      logger.error(
        {
          videoId,
          playlistId,
          userId,
          videoPlaylistId: video.playlist_id,
          videoUserId: video.user_id
        },
        "Analyze video payload mismatch"
      );
      return { status: "skipped", reason: "payload_mismatch" };
    }

    const existing = await fetchAnalysisRecord(db, videoId, promptHash);
    if (existing && (existing.status === "completed" || existing.status === "skipped")) {
      logger.info({ videoId, analysisId: existing.id, status: existing.status }, "Analyze video skipped; already done");
      return { status: existing.status, analysisId: existing.id, reason: "analysis_exists" };
    }

    const durationSec = parseDurationToSeconds(video.duration);
    if (durationSec > ANALYSIS_MAX_DURATION_SEC) {
      const analysisId = await upsertVideoAnalysis(db, {
        videoId,
        playlistId,
        userId,
        prompt,
        promptHash,
        status: "skipped",
        model: config.geminiModel,
        analysisText: "",
        usage: null,
        error: null,
        skipReason: "duration_exceeded"
      });
      logger.info({ videoId, analysisId }, "Analyze video skipped; duration exceeded");
      return { status: "skipped", reason: "duration_exceeded", analysisId };
    }

    if (video.sync_status !== "synced") {
      const analysisId = await upsertVideoAnalysis(db, {
        videoId,
        playlistId,
        userId,
        prompt,
        promptHash,
        status: "skipped",
        model: config.geminiModel,
        analysisText: "",
        usage: null,
        error: null,
        skipReason: "video_unavailable"
      });
      logger.info({ videoId, analysisId, syncStatus: video.sync_status }, "Analyze video skipped; unavailable");
      return { status: "skipped", reason: "video_unavailable", analysisId };
    }

    const model = config.geminiModel;
    let analysisId = existing?.id ?? null;

    if (analysisId) {
      await updateVideoAnalysis(db, {
        id: analysisId,
        status: "processing",
        model,
        analysisText: "",
        usage: null,
        error: null,
        skipReason: null
      });
    } else {
      analysisId = await upsertVideoAnalysis(db, {
        videoId,
        playlistId,
        userId,
        prompt,
        promptHash,
        status: "processing",
        model,
        analysisText: "",
        usage: null,
        error: null,
        skipReason: null
      });
    }

    if (!analysisId) {
      logger.warn({ videoId }, "Analyze video skipped; failed to create analysis record");
      return { status: "skipped", reason: "analysis_record_missing" };
    }

    if (!config.geminiApiKey) {
      const errorMessage = "GEMINI_API_KEY is not configured";
      await updateVideoAnalysis(db, {
        id: analysisId,
        status: "failed",
        model,
        analysisText: errorMessage,
        usage: null,
        error: errorMessage,
        skipReason: null
      });
      logger.error({ videoId, analysisId }, errorMessage);
      return { status: "failed", analysisId, error: errorMessage };
    }

    const content = buildAnalysisInput(video, prompt);

    try {
      const result = await generateGeminiAnalysis({
        apiKey: config.geminiApiKey,
        model,
        content
      });

      await updateVideoAnalysis(db, {
        id: analysisId,
        status: "completed",
        model,
        analysisText: result.text,
        usage: result.usage,
        error: null,
        skipReason: null
      });

      logger.info({ videoId, analysisId, model }, "Analyze video completed");
      return { status: "completed", analysisId };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "unknown_error";
      await updateVideoAnalysis(db, {
        id: analysisId,
        status: "failed",
        model,
        analysisText: errorMessage,
        usage: null,
        error: errorMessage,
        skipReason: null
      });
      captureException(error);
      logger.error({ videoId, analysisId, err: error }, "Analyze video failed");
      throw error;
    }
  });
}
