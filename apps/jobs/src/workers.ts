import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Logger } from "pino";
import { chat, type StreamChunk } from "@tanstack/ai";
import { createGeminiChat } from "@tanstack/ai-gemini";
import { captureException } from "./sentry.js";
import type { Config } from "./config.js";
import type { DbPool } from "./db.js";

const ANALYSIS_MAX_DURATION_SEC = 3600;
const ANALYSIS_PROCESSING_TIMEOUT_MS = 15 * 60 * 1000;
const ANALYSIS_SUMMARY_MIN_LENGTH = 20;
const ANALYSIS_TIMESTAMP_PATTERN = "^\\d{2}:\\d{2}$|^\\d{1,2}:\\d{2}:\\d{2}$";
const ANALYSIS_TIMESTAMP_REGEX = /^(?:\d{2}:\d{2}|\d{1,2}:\d{2}:\d{2})$/;
// eslint-disable-next-line @typescript-eslint/naming-convention
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
    },
    characters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: {
            type: "string",
            minLength: 1,
            description: "Name of the character or 'Unknown Speaker N'."
          },
          kind: {
            type: "string",
            enum: ["host", "guest", "narrator", "character", "unknown"],
            description: "Role type of the character."
          },
          description: {
            type: "string",
            minLength: 1,
            description: "Brief description of the character."
          },
          traits: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 6,
            description: "2-6 short tags describing the character."
          },
          speaking_style: {
            type: "string",
            minLength: 1,
            description: "Description of how the character speaks."
          },
          notable_topics: {
            type: "array",
            items: { type: "string" },
            description: "Topics the character discusses."
          },
          evidence: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                timestamp: {
                  type: "string",
                  pattern: ANALYSIS_TIMESTAMP_PATTERN,
                  description: "Timestamp of the quote."
                },
                quote: {
                  type: "string",
                  maxLength: 200,
                  description: "Short quote (<= 20 words)."
                }
              },
              required: ["timestamp", "quote"]
            },
            minItems: 1,
            maxItems: 3,
            description: "1-3 short quotes with timestamps."
          }
        },
        required: ["name", "kind", "description", "traits", "speaking_style", "notable_topics", "evidence"]
      },
      maxItems: 8,
      description: "0-8 main characters/speakers in the video."
    },
    transcript: {
      type: "object",
      additionalProperties: false,
      properties: {
        language: {
          type: "string",
          minLength: 1,
          description: "Language of the transcript."
        },
        is_truncated: {
          type: "boolean",
          description: "Whether the transcript is truncated."
        },
        cursor: {
          type: "string",
          description: "Cursor for pagination, empty if not truncated."
        },
        segments: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              start: {
                type: "string",
                pattern: ANALYSIS_TIMESTAMP_PATTERN,
                description: "Start timestamp."
              },
              end: {
                type: "string",
                pattern: ANALYSIS_TIMESTAMP_PATTERN,
                description: "End timestamp."
              },
              speaker: {
                type: "string",
                description: "Speaker name or identifier."
              },
              text: {
                type: "string",
                minLength: 1,
                description: "Transcript text (1-2 sentences)."
              }
            },
            required: ["start", "end", "speaker", "text"]
          },
          description: "Chronological transcript segments."
        }
      },
      required: ["language", "is_truncated", "cursor", "segments"],
      description: "Transcript with speaker diarization."
    }
  },
  required: ["summarize", "wiki", "characters", "transcript"]
};

const ANALYSIS_PROMPT_BASE = [
  "Return ONLY a valid JSON object (RFC 8259). Use double quotes for all keys and strings.",
  "Do not include any extra keys, markdown, code fences, comments, or surrounding text.",
  "",
  "The JSON must match exactly this schema:",
  "{",
  "  \"summarize\": string,",
  "  \"wiki\": [{\"timestamp\": string, \"title\": string, \"details\": string}],",
  "  \"characters\": [{",
  "    \"name\": string,",
  "    \"kind\": \"host\"|\"guest\"|\"narrator\"|\"character\"|\"unknown\",",
  "    \"description\": string,",
  "    \"traits\": [string],",
  "    \"speaking_style\": string,",
  "    \"notable_topics\": [string],",
  "    \"evidence\": [{\"timestamp\": string, \"quote\": string}],",
  "  }],",
  "  \"transcript\": {",
  "    \"language\": string,",
  "    \"is_truncated\": boolean,",
  "    \"cursor\": string,",
  "    \"segments\": [{\"start\": string, \"end\": string, \"speaker\": string, \"text\": string}]",
  "  }",
  "}",
  "",
  "General rules:",
  "- Always use English, regardless of the video's language or the user's prompt language.",
  "- Do not invent facts.",
  "",
  "\"summarize\":",
  "- 3-6 sentences covering the main thesis and key takeaways. No bullet points.",
  "",
  "\"wiki\":",
  "- Chronological (non-decreasing timestamps), 6-12 items when possible.",
  "- \"timestamp\" must match ^\\d{2}:\\d{2}$ or ^\\d{1,2}:\\d{2}:\\d{2}$.",
  "- \"details\" must be 1-3 sentences with concrete points; do not repeat the summary verbatim.",
  "- If unclear, say so in \"details\".",
  "",
  "\"characters\":",
  "- 0-8 items. If no clear main speakers/roles, return [].",
  "- Do not include people only mentioned in passing.",
  "- If name is unknown, use \"Unknown Speaker 1\", \"Unknown Speaker 2\", etc.",
  "- \"traits\": 2-6 short tags.",
  "- \"evidence\": 1-3 short quotes (<= 20 words each) with timestamps.",
  "",
  "\"transcript\":",
  "- \"segments\" must be chronological.",
  "- \"start\" and \"end\" timestamps must match the same timestamp regex.",
  "- Keep each \"text\" concise (1-2 sentences).",
  "- Return as much transcript as possible within the output limit.",
  "- If not all transcript can be returned, set \"is_truncated\" to true and set a non-empty \"cursor\" that can be used to continue from where you stopped.",
  "- If all transcript is covered, set \"is_truncated\" to false and set \"cursor\" to \"\"."
].join("\n");

const ANALYSIS_STATUS = {
  queued: "queued",
  pending: "pending",
  processing: "processing",
  completed: "completed",
  failed: "failed",
  skipped: "skipped"
} as const;

type AnalysisStatus = (typeof ANALYSIS_STATUS)[keyof typeof ANALYSIS_STATUS];

const ANALYSIS_MUTABLE_STATUSES: AnalysisStatus[] = [
  ANALYSIS_STATUS.queued,
  ANALYSIS_STATUS.pending,
  ANALYSIS_STATUS.failed
];

type AnalyzeVideoPayload = {
  videoId: string;
  userId: string;
  prompt: string;
};

type VideoAnalysisTarget = {
  id: string;
  user_id: string;
  youtube_video_id: string;
  title: string | null;
  description: string | null;
  duration: string | null;
  status: string;
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

function normalizeJobList<T>(jobs: JobWithMetadata<T>[] | JobWithMetadata<T>) {
  return Array.isArray(jobs) ? jobs : [jobs];
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

function buildAnalysisPrompt() {
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
  const isTimeout = Boolean(code && RETRYABLE_ERROR_CODES.has(code)) || /timed?\s*out/i.test(message);
  const retryable = isTimeout || status === 429 || (typeof status === "number" && status >= 500);
  return { message, status, retryable };
}

async function fetchVideoForAnalysis(db: DbPool, videoId: string) {
  const result = await db.query<VideoAnalysisTarget>(
    `select v.id,
            v.user_id,
            v.youtube_video_id,
            v.title,
            v.description,
            v.duration,
            v.status,
            v.raw
     from videos v
     where v.id = $1`,
    [videoId]
  );

  return result.rows[0] ?? null;
}

async function fetchAnalysisRecord(db: DbPool, videoId: string) {
  const result = await db.query<AnalysisRecord>(
    `select id, status, updated_at
     from video_analyses
     where video_id = $1
     limit 1`,
    [videoId]
  );
  return result.rows[0] ?? null;
}

async function upsertVideoAnalysisIfStatus(
  db: DbPool,
  params: {
    videoId: string;
    userId: string;
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
       analysis_text = excluded.analysis_text,
       model = excluded.model,
       usage = excluded.usage,
       status = excluded.status,
       error = excluded.error,
       skip_reason = excluded.skip_reason
     where video_analyses.status = any($9::text[])
     returning id, status`,
    [
      params.videoId,
      params.userId,
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
  failedCountUpdate?: "increment" | "reset";
}) {
  const failedCountExpression =
    params.failedCountUpdate === "increment"
      ? "failed_count + 1"
      : params.failedCountUpdate === "reset"
        ? "0"
        : "failed_count";

  await db.query(
    `update video_analyses
     set analysis_text = $1,
     model = $2,
     usage = $3,
     status = $4,
     error = $5,
     skip_reason = $6,
     failed_count = ${failedCountExpression}
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

async function refundAnalysisQuota(db: DbPool, userId: string) {
  await db.query(
    `update user_quotas
     set analysis_count = greatest(analysis_count - 1, 0)
     where user_id = $1`,
    [userId]
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
            content: buildAnalysisPrompt()
          }
        ]
      }
    ],
    temperature: 0.2,
    topP: 0.9,
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

export async function registerWorkers(params: {
  boss: PgBoss;
  db: DbPool;
  logger: Logger;
  config: Config;
}) {
  const { boss, db, logger, config } = params;

  // Ensure queue exists before registering worker
  await boss.createQueue("analyze.video");

  const handleAnalyzeVideoJob = async (job: any) => {
    const payload = job.data as AnalyzeVideoPayload | null;
    const videoId = payload?.videoId;
    const userId = payload?.userId;
    const prompt = payload?.prompt;

    if (!videoId || !userId || !prompt) {
      logger.error({ jobId: job.id }, "analyze.video missing required payload");
      throw new Error("analyze.video missing required payload");
    }

    logger.info({ jobId: job.id, videoId, userId }, "Analyze video started");

    const video = await fetchVideoForAnalysis(db, videoId);
    if (!video) {
      logger.warn({ videoId, userId, jobId: job.id }, "Analyze video skipped; video missing");
      return { status: ANALYSIS_STATUS.skipped, reason: "video_missing" };
    }

    if (video.user_id !== userId) {
      logger.error(
        {
          videoId,
          userId,
          videoUserId: video.user_id
        },
        "Analyze video payload mismatch"
      );
      return { status: ANALYSIS_STATUS.skipped, reason: "payload_mismatch" };
    }

    const existing = await fetchAnalysisRecord(db, videoId);
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
        userId,
        status: ANALYSIS_STATUS.skipped,
        model: config.geminiModel,
        analysisText: "Skipped: duration_exceeded",
        usage: null,
        error: null,
        skipReason: "duration_exceeded",
        allowedStatuses: reclaimableStatuses
      });
      if (!skipped) {
        const current = await fetchAnalysisRecord(db, videoId);
        logger.info({ videoId, analysisId: current?.id }, "Analyze video skipped; already handled");
        return { status: current?.status ?? ANALYSIS_STATUS.skipped, analysisId: current?.id, reason: "analysis_exists" };
      }
      logger.info({ videoId, analysisId: skipped.id }, "Analyze video skipped; duration exceeded");
      return { status: ANALYSIS_STATUS.skipped, reason: "duration_exceeded", analysisId: skipped.id };
    }

    if (video.status !== "active") {
      const skipped = await upsertVideoAnalysisIfStatus(db, {
        videoId,
        userId,
        status: ANALYSIS_STATUS.skipped,
        model: config.geminiModel,
        analysisText: "Skipped: video_unavailable",
        usage: null,
        error: null,
        skipReason: "video_unavailable",
        allowedStatuses: reclaimableStatuses
      });
      if (!skipped) {
        const current = await fetchAnalysisRecord(db, videoId);
        logger.info({ videoId, analysisId: current?.id }, "Analyze video skipped; already handled");
        return { status: current?.status ?? ANALYSIS_STATUS.skipped, analysisId: current?.id, reason: "analysis_exists" };
      }
      logger.info({ videoId, analysisId: skipped.id, status: video.status }, "Analyze video skipped; unavailable");
      return { status: ANALYSIS_STATUS.skipped, reason: "video_unavailable", analysisId: skipped.id };
    }

    const model = config.geminiModel;
    const claimed = await upsertVideoAnalysisIfStatus(db, {
      videoId,
      userId,
      status: ANALYSIS_STATUS.processing,
      model,
      analysisText: "",
      usage: null,
      error: null,
      skipReason: null,
      allowedStatuses: reclaimableStatuses
    });

    if (!claimed) {
      const current = await fetchAnalysisRecord(db, videoId);
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
        skipReason: null,
        failedCountUpdate: "increment"
      });
      await refundAnalysisQuota(db, userId);
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
        skipReason: null,
        failedCountUpdate: "increment"
      });
      await refundAnalysisQuota(db, userId);
      if (retryable) {
        logger.warn({ videoId, analysisId, status, errorMessage: message }, "Analyze video retryable error");
        throw error;
      }
      captureException(error);
      logger.error({ videoId, analysisId, err: error, errorMessage: message }, "Analyze video failed");
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
        skipReason: null,
        failedCountUpdate: "increment"
      });
      await refundAnalysisQuota(db, userId);
      captureException(error);
      logger.error(
        { videoId, analysisId, err: error, errorMessage },
        "Analyze video response invalid"
      );
      return { status: ANALYSIS_STATUS.failed, analysisId, error: errorMessage };
    }

    await updateVideoAnalysis(db, {
      id: analysisId,
      status: ANALYSIS_STATUS.completed,
      model,
      analysisText: JSON.stringify(parsed),
      usage,
      error: null,
      skipReason: null,
      failedCountUpdate: "reset"
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
