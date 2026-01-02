import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Logger } from "pino";
import { chat, type StreamChunk } from "@tanstack/ai";
import { createGeminiChat } from "@tanstack/ai-gemini";
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
const ANALYSIS_PROCESSING_TIMEOUT_MS = 15 * 60 * 1000;
const ANALYSIS_SUMMARY_MIN_LENGTH = 20;
const ANALYSIS_TIMESTAMP_PATTERN = "^\\d{2}:\\d{2}$|^\\d{1,2}:\\d{2}:\\d{2}$";
const ANALYSIS_TIMESTAMP_REGEX = /^(?:\d{2}:\d{2}|\d{1,2}:\d{2}:\d{2})$/;
const ANALYSIS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summarize: {
      type: "string",
      minLength: ANALYSIS_SUMMARY_MIN_LENGTH,
      description: "Concise 3-6 sentence summary of the video."
    },
    wiki: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          timestamp: {
            type: "string",
            pattern: ANALYSIS_TIMESTAMP_PATTERN,
            description: "Timestamp in MM:SS or H:MM:SS."
          },
          title: {
            type: "string",
            minLength: 1,
            description: "Section title."
          },
          details: {
            type: "string",
            minLength: 1,
            description: "1-3 sentences describing what happens at this time."
          }
        },
        required: ["timestamp", "title", "details"]
      }
    }
  },
  required: ["summarize", "wiki"]
};

const ANALYSIS_PROMPT_BASE = [
  "You are analyzing a YouTube video based on its transcript and metadata.",
  "Return ONLY a valid JSON object (RFC 8259). Use double quotes for all keys and strings.",
  "The JSON must match exactly this schema: {\"summarize\": string, \"wiki\": [{\"timestamp\": string, \"title\": string, \"details\": string}]}",
  "Do not include any extra keys, comments, or surrounding text.",
  "\"summarize\" must be 3-6 sentences covering the main thesis and key takeaways (no bullet points).",
  "\"wiki\" must be chronological (non-decreasing timestamps) and have 6-12 items when possible.",
  "Each \"timestamp\" must match ^\\d{2}:\\d{2}$ or ^\\d{1,2}:\\d{2}:\\d{2}$.",
  "Each \"details\" should be 1-3 sentences with concrete points from that segment; do not repeat the summary verbatim.",
  "Use the same language as the video or the user's prompt.",
  "Do not invent facts. If the transcript is unclear for a segment, say so in \"details\" without adding new fields."
].join("\n");

const ANALYSIS_STATUS = {
  pending: "pending",
  processing: "processing",
  completed: "completed",
  failed: "failed",
  skipped: "skipped"
} as const;

type AnalysisStatus = (typeof ANALYSIS_STATUS)[keyof typeof ANALYSIS_STATUS];

const ANALYSIS_MUTABLE_STATUSES: AnalysisStatus[] = [
  ANALYSIS_STATUS.pending,
  ANALYSIS_STATUS.failed
];
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
  status: AnalysisStatus;
  updated_at: string | null;
};

type AnalysisOutput = {
  summarize: string;
  wiki: Array<{
    timestamp: string;
    title: string;
    details: string;
  }>;
};

type GeminiModel = Parameters<typeof createGeminiChat>[0];

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
  if (!value) return null;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function buildAnalysisPrompt(prompt: string) {
  return ANALYSIS_PROMPT_BASE;
}

function buildYoutubeVideoUrl(videoId: string) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function stripJsonFences(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function parseTimestampToSeconds(value: string) {
  const trimmed = value.trim();
  if (!ANALYSIS_TIMESTAMP_REGEX.test(trimmed)) return null;

  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  const shortMatch = /^(\d{2}):(\d{2})$/.exec(trimmed);
  if (shortMatch) {
    minutes = Number(shortMatch[1]);
    seconds = Number(shortMatch[2]);
  } else {
    const longMatch = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(trimmed);
    if (!longMatch) return null;
    hours = Number(longMatch[1]);
    minutes = Number(longMatch[2]);
    seconds = Number(longMatch[3]);
  }

  if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || !Number.isFinite(hours)) {
    return null;
  }

  if (minutes >= 60 || seconds >= 60 || minutes < 0 || seconds < 0 || hours < 0) {
    return null;
  }

  return hours * 3600 + minutes * 60 + seconds;
}

function isValidAnalysisOutput(value: unknown): value is AnalysisOutput {
  if (!value || typeof value !== "object") return false;
  const record = value as AnalysisOutput;
  if (typeof record.summarize !== "string") return false;

  const summary = record.summarize.trim();
  if (!summary) return false;
  if (summary.length < ANALYSIS_SUMMARY_MIN_LENGTH) return false;

  if (!Array.isArray(record.wiki) || record.wiki.length === 0) return false;

  let lastSeconds: number | null = null;
  for (const item of record.wiki) {
    if (!item || typeof item !== "object") return false;
    const timestamp = item.timestamp?.trim();
    const title = item.title?.trim();
    const details = item.details?.trim();

    if (!timestamp || !title || !details) return false;

    const seconds = parseTimestampToSeconds(timestamp);
    if (seconds === null) return false;
    if (lastSeconds !== null && seconds < lastSeconds) return false;
    lastSeconds = seconds;
  }

  return true;
}

function parseAnalysisOutput(rawText: string) {
  const cleaned = stripJsonFences(rawText);
  if (!cleaned) {
    throw new Error("Gemini response was empty");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    throw new Error(
      `Failed to parse Gemini JSON: ${error instanceof Error ? error.message : "unknown_error"}`
    );
  }
  if (!isValidAnalysisOutput(parsed)) {
    throw new Error("Gemini JSON did not match expected schema");
  }
  return parsed;
}

async function collectStream(stream: AsyncIterable<StreamChunk>) {
  let content = "";
  let usage: Record<string, unknown> | null = null;
  let errorMessage: string | null = null;

  for await (const chunk of stream) {
    if (chunk.type === "content" && chunk.delta) {
      content += chunk.delta;
    }
    if (chunk.type === "done") {
      usage = chunk.usage ?? null;
    }
    if (chunk.type === "error") {
      errorMessage = chunk.error?.message ?? "Gemini error";
    }
  }

  if (errorMessage) {
    throw new Error(errorMessage);
  }

  return { content: content.trim(), usage };
}

function parseTimestampToMs(value?: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function isProcessingStale(record: AnalysisRecord | null) {
  if (!record || record.status !== ANALYSIS_STATUS.processing) return false;
  const updatedAtMs = parseTimestampToMs(record.updated_at);
  if (updatedAtMs === null) return false;
  return Date.now() - updatedAtMs > ANALYSIS_PROCESSING_TIMEOUT_MS;
}

const RETRYABLE_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENETUNREACH"
]);

function extractErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const record = error as {
    status?: number;
    statusCode?: number;
    code?: number | string;
    cause?: unknown;
  };
  if (typeof record.status === "number") return record.status;
  if (typeof record.statusCode === "number") return record.statusCode;
  if (typeof record.code === "number") return record.code;
  if (record.cause && typeof record.cause === "object") {
    const causeStatus = extractErrorStatus(record.cause);
    if (typeof causeStatus === "number") return causeStatus;
  }
  return null;
}

function extractMessageStatus(message: string) {
  const match = /(?:status|code)\D*(\d{3})/i.exec(message);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isNaN(parsed) ? null : parsed;
}

function classifyGeminiError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "unknown_error");
  const status = extractErrorStatus(error) ?? extractMessageStatus(message);
  const code = typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code?: string }).code
    : null;
  const isTimeout = Boolean(code && RETRYABLE_ERROR_CODES.has(code)) || /timed?\\s*out/i.test(message);
  const retryable = isTimeout || status === 429 || (typeof status === "number" && status >= 500);
  return { message, status, retryable };
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
    `select id, status, updated_at
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
  status: AnalysisStatus;
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
       playlist_id = excluded.playlist_id,
       user_id = excluded.user_id,
       prompt = excluded.prompt,
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

async function upsertVideoAnalysisIfStatus(
  db: DbPool,
  params: {
    videoId: string;
    playlistId: string;
    userId: string;
    prompt: string;
    promptHash: string;
    status: AnalysisStatus;
    model: string;
    analysisText: string;
    usage: Record<string, unknown> | null;
    error: string | null;
    skipReason: string | null;
    allowedStatuses: AnalysisStatus[];
  }
) {
  const result = await db.query<{ id: string; status: AnalysisStatus }>(
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
       playlist_id = excluded.playlist_id,
       user_id = excluded.user_id,
       prompt = excluded.prompt,
       analysis_text = excluded.analysis_text,
       model = excluded.model,
       usage = excluded.usage,
       status = excluded.status,
       error = excluded.error,
       skip_reason = excluded.skip_reason
     where video_analyses.status = any($12::text[])
     returning id, status`,
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
      params.skipReason,
      params.allowedStatuses
    ]
  );

  return result.rows[0] ?? null;
}

async function updateVideoAnalysis(db: DbPool, params: {
  id: string;
  status: AnalysisStatus;
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

async function generateGeminiAnalysis(params: {
  apiKey: string;
  model: GeminiModel;
  videoUrl: string;
  prompt: string;
}) {
  const adapter = createGeminiChat(params.model, params.apiKey);
  const stream = chat({
    adapter,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "video",
            source: { type: "url", value: params.videoUrl }
          },
          {
            type: "text",
            content: buildAnalysisPrompt(params.prompt)
          }
        ]
      }
    ],
    temperature: 0.2,
    maxTokens: 65536,
    modelOptions: {
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: ANALYSIS_OUTPUT_SCHEMA as unknown as any
      }
    }
  });

  return collectStream(stream);
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
        logger.error({ jobId: job.id }, "sync.playlist missing required payload");
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

  const handleAnalyzeVideoJob = async (job: any) => {
    const payload = job.data as AnalyzeVideoPayload | null;
    const videoId = payload?.videoId;
    const playlistId = payload?.playlistId;
    const userId = payload?.userId;
    const prompt = payload?.prompt;
    const promptHash = payload?.promptHash;

    if (!videoId || !playlistId || !userId || !prompt || !promptHash) {
      logger.error({ jobId: job.id }, "analyze.video missing required payload");
      throw new Error("analyze.video missing required payload");
    }

    logger.info({ jobId: job.id, videoId, playlistId, userId }, "Analyze video started");

    const video = await fetchVideoForAnalysis(db, videoId);
    if (!video) {
      logger.warn({ videoId, playlistId, userId, jobId: job.id }, "Analyze video skipped; video missing");
      return { status: ANALYSIS_STATUS.skipped, reason: "video_missing" };
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
      return { status: ANALYSIS_STATUS.skipped, reason: "payload_mismatch" };
    }

    const existing = await fetchAnalysisRecord(db, videoId, promptHash);
    if (existing && (existing.status === ANALYSIS_STATUS.completed || existing.status === ANALYSIS_STATUS.skipped)) {
      logger.info({ videoId, analysisId: existing.id, status: existing.status }, "Analyze video skipped; already done");
      return { status: existing.status, analysisId: existing.id, reason: "analysis_exists" };
    }

    const processingStale = isProcessingStale(existing);
    const reclaimableStatuses = processingStale
      ? [...ANALYSIS_MUTABLE_STATUSES, ANALYSIS_STATUS.processing]
      : ANALYSIS_MUTABLE_STATUSES;

    if (existing?.status === ANALYSIS_STATUS.processing && !processingStale) {
      logger.info({ videoId, analysisId: existing.id }, "Analyze video skipped; already processing");
      return { status: ANALYSIS_STATUS.processing, analysisId: existing.id, reason: "analysis_in_progress" };
    }
    if (processingStale) {
      logger.warn({ videoId, analysisId: existing?.id }, "Analyze video reclaiming stale processing");
    }

    const durationSec = parseDurationToSeconds(video.duration);
    if (durationSec !== null && durationSec > ANALYSIS_MAX_DURATION_SEC) {
      const skipped = await upsertVideoAnalysisIfStatus(db, {
        videoId,
        playlistId,
        userId,
        prompt,
        promptHash,
        status: ANALYSIS_STATUS.skipped,
        model: config.geminiModel,
        analysisText: "Skipped: duration_exceeded",
        usage: null,
        error: null,
        skipReason: "duration_exceeded",
        allowedStatuses: reclaimableStatuses
      });
      if (!skipped) {
        const current = await fetchAnalysisRecord(db, videoId, promptHash);
        logger.info({ videoId, analysisId: current?.id }, "Analyze video skipped; already handled");
        return { status: current?.status ?? ANALYSIS_STATUS.skipped, analysisId: current?.id, reason: "analysis_exists" };
      }
      logger.info({ videoId, analysisId: skipped.id }, "Analyze video skipped; duration exceeded");
      return { status: ANALYSIS_STATUS.skipped, reason: "duration_exceeded", analysisId: skipped.id };
    }

    if (video.sync_status !== "synced") {
      const skipped = await upsertVideoAnalysisIfStatus(db, {
        videoId,
        playlistId,
        userId,
        prompt,
        promptHash,
        status: ANALYSIS_STATUS.skipped,
        model: config.geminiModel,
        analysisText: "Skipped: video_unavailable",
        usage: null,
        error: null,
        skipReason: "video_unavailable",
        allowedStatuses: reclaimableStatuses
      });
      if (!skipped) {
        const current = await fetchAnalysisRecord(db, videoId, promptHash);
        logger.info({ videoId, analysisId: current?.id }, "Analyze video skipped; already handled");
        return { status: current?.status ?? ANALYSIS_STATUS.skipped, analysisId: current?.id, reason: "analysis_exists" };
      }
      logger.info({ videoId, analysisId: skipped.id, syncStatus: video.sync_status }, "Analyze video skipped; unavailable");
      return { status: ANALYSIS_STATUS.skipped, reason: "video_unavailable", analysisId: skipped.id };
    }

    const model = config.geminiModel;
    const claimed = await upsertVideoAnalysisIfStatus(db, {
      videoId,
      playlistId,
      userId,
      prompt,
      promptHash,
      status: ANALYSIS_STATUS.processing,
      model,
      analysisText: "",
      usage: null,
      error: null,
      skipReason: null,
      allowedStatuses: reclaimableStatuses
    });

    if (!claimed) {
      const current = await fetchAnalysisRecord(db, videoId, promptHash);
      if (current) {
        logger.info({ videoId, analysisId: current.id, status: current.status }, "Analyze video skipped; already handled");
        return { status: current.status, analysisId: current.id, reason: "analysis_exists" };
      }
      logger.warn({ videoId }, "Analyze video skipped; failed to claim analysis record");
      return { status: ANALYSIS_STATUS.skipped, reason: "analysis_record_missing" };
    }

    const analysisId = claimed.id;

    if (!config.geminiApiKey) {
      const errorMessage = "GEMINI_API_KEY is not configured";
      await updateVideoAnalysis(db, {
        id: analysisId,
        status: ANALYSIS_STATUS.failed,
        model,
        analysisText: errorMessage,
        usage: null,
        error: errorMessage,
        skipReason: null
      });
      logger.error({ videoId, analysisId }, errorMessage);
      return { status: ANALYSIS_STATUS.failed, analysisId, error: errorMessage };
    }

    const videoUrl = buildYoutubeVideoUrl(video.youtube_video_id);

    let responseText = "";
    let usage: Record<string, unknown> | null = null;

    try {
      const result = await generateGeminiAnalysis({
        apiKey: config.geminiApiKey,
        model: model as GeminiModel,
        videoUrl,
        prompt
      });
      responseText = result.content;
      usage = result.usage ?? null;
    } catch (error) {
      const { message, status, retryable } = classifyGeminiError(error);
      await updateVideoAnalysis(db, {
        id: analysisId,
        status: ANALYSIS_STATUS.failed,
        model,
        analysisText: message,
        usage: null,
        error: message,
        skipReason: null
      });
      if (retryable) {
        logger.warn({ videoId, analysisId, status }, "Analyze video retryable error");
        throw error;
      }
      captureException(error);
      logger.error({ videoId, analysisId, err: error }, "Analyze video failed");
      return { status: ANALYSIS_STATUS.failed, analysisId, error: message };
    }

    let parsed: AnalysisOutput;
    try {
      parsed = parseAnalysisOutput(responseText);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "invalid_analysis_output";
      await updateVideoAnalysis(db, {
        id: analysisId,
        status: ANALYSIS_STATUS.failed,
        model,
        analysisText: responseText || errorMessage,
        usage,
        error: errorMessage,
        skipReason: null
      });
      captureException(error);
      logger.error({ videoId, analysisId, err: error }, "Analyze video response invalid");
      return { status: ANALYSIS_STATUS.failed, analysisId, error: errorMessage };
    }

    await updateVideoAnalysis(db, {
      id: analysisId,
      status: ANALYSIS_STATUS.completed,
      model,
      analysisText: JSON.stringify(parsed),
      usage,
      error: null,
      skipReason: null
    });

    logger.info({ videoId, analysisId, model }, "Analyze video completed");
    return { status: ANALYSIS_STATUS.completed, analysisId };
  };

  await boss.work("analyze.video", async (jobs: any) => {
    const jobList = normalizeJobList(jobs ?? []);
    if (jobList.length === 0) {
      logger.error("Analyze video worker received empty job batch");
      return { status: ANALYSIS_STATUS.failed, reason: "job_missing" };
    }

    const results = [];
    for (const job of jobList) {
      results.push(await handleAnalyzeVideoJob(job));
    }

    return results.length === 1 ? results[0] : results;
  });
}
