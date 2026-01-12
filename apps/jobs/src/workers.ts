import type { Job, PgBoss } from "pg-boss";
import type { Logger } from "pino";
import { chat, type StreamChunk } from "@tanstack/ai";
import { createGeminiChat } from "@tanstack/ai-gemini";
import { captureException } from "./sentry.js";
import type { Config } from "./config.js";
import type { DbPool } from "./db.js";

const ANALYSIS_SUMMARY_MIN_LENGTH = 20;
const ANALYSIS_TIMESTAMP_PATTERN = "^\\d{2}:\\d{2}$|^\\d{1,2}:\\d{2}:\\d{2}$";
const ANALYSIS_TIMESTAMP_REGEX = /^(?:\d{2}:\d{2}|\d{1,2}:\d{2}:\d{2})$/;
// eslint-disable-next-line @typescript-eslint/naming-convention
const ANALYSIS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    scene: {
      type: "string",
      minLength: 1,
      description: "Describes both the physical environment and the 'vibe'."
    },
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
            description: "Description of how the character speaks, including accent, speaking pace (slow/moderate/fast), tone, pitch, energy level, and any distinctive speech patterns."
          },
          notable_topics: {
            type: "array",
            items: { type: "string" },
            description: "Topics the character discusses."
          },
          voice: {
            type: "string",
            enum: [
              "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda",
              "Orus", "Aoede", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus",
              "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi",
              "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima",
              "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat"
            ],
            description: "Voice for TTS. Choose based on character's speaking style and personality. Voice tones: Zephyr=Bright, Puck=Upbeat, Charon=Informative, Kore=Firm, Fenrir=Excitable, Leda=Youthful, Orus=Firm, Aoede=Breezy, Callirrhoe=Easy-going, Autonoe=Bright, Enceladus=Breathy, Iapetus=Clear, Umbriel=Easy-going, Algieba=Smooth, Despina=Smooth, Erinome=Clear, Algenib=Gravelly, Rasalgethi=Informative, Laomedeia=Upbeat, Achernar=Soft, Alnilam=Firm, Schedar=Even, Gacrux=Mature, Pulcherrima=Forward, Achird=Friendly, Zubenelgenubi=Casual, Vindemiatrix=Gentle, Sadachbia=Lively, Sadaltager=Knowledgeable, Sulafat=Warm."
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
        required: ["name", "kind", "description", "traits", "speaking_style", "notable_topics", "evidence", "voice"]
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
  required: ["scene", "summarize", "wiki", "characters", "transcript"]
};

const ANALYSIS_PROMPT_BASE = [
  "Return ONLY a valid JSON object (RFC 8259). Use double quotes for all keys and strings.",
  "Do not include any extra keys, markdown, code fences, comments, or surrounding text.",
  "",
  "The JSON must match exactly this schema:",
  "{",
  "  \"scene\": string,",
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
  "    \"voice\": string",
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
  "\"scene\":",
  "- Sets the stage. Describes both the physical environment and the \"vibe\".",
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
  "- \"voice\": Choose the best matching voice for TTS based on the character's personality and speaking style.",
  "  Available voices (Name -- Tone): Zephyr--Bright, Puck--Upbeat, Charon--Informative, Kore--Firm, Fenrir--Excitable, Leda--Youthful,",
  "  Orus--Firm, Aoede--Breezy, Callirrhoe--Easy-going, Autonoe--Bright, Enceladus--Breathy, Iapetus--Clear,",
  "  Umbriel--Easy-going, Algieba--Smooth, Despina--Smooth, Erinome--Clear, Algenib--Gravelly, Rasalgethi--Informative,",
  "  Laomedeia--Upbeat, Achernar--Soft, Alnilam--Firm, Schedar--Even, Gacrux--Mature, Pulcherrima--Forward,",
  "  Achird--Friendly, Zubenelgenubi--Casual, Vindemiatrix--Gentle, Sadachbia--Lively, Sadaltager--Knowledgeable, Sulafat--Warm.",
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
  pending: "pending",
  completed: "completed",
  failed: "failed",
  skipped: "skipped"
} as const;

type AnalysisStatus = (typeof ANALYSIS_STATUS)[keyof typeof ANALYSIS_STATUS];

type AnalyzeVideoPayload = {
  videoId: string;
  userId: string;
  analysisId?: string;
};

type VideoAnalysisTarget = {
  id: string;
  user_id: string;
  youtube_video_id: string;
  title: string | null;
  description: string | null;
  duration: string | null;
  raw: Record<string, unknown> | null;
};

type CharacterEvidence = {
  timestamp: string;
  quote: string;
};

type AnalysisCharacter = {
  name: string;
  kind: string;
  description: string;
  traits: string[];
  speaking_style: string;
  notable_topics: string[];
  evidence: CharacterEvidence[];
  voice: string;
};

type TranscriptSegment = {
  start: string;
  end: string;
  speaker: string;
  text: string;
};

type AnalysisTranscript = {
  language: string;
  is_truncated: boolean;
  cursor: string;
  segments: TranscriptSegment[];
};

type AnalysisOutput = {
  scene: string;
  summarize: string;
  wiki: Array<{
    timestamp: string;
    title: string;
    details: string;
  }>;
  characters: AnalysisCharacter[];
  transcript: AnalysisTranscript;
};

type GeminiModel = Parameters<typeof createGeminiChat>[0];

function normalizeJobList<T>(jobs: Job<T>[] | Job<T>) {
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
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
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

  // Validate scene
  if (typeof record.scene !== "string" || !record.scene.trim()) return false;

  // Validate summarize
  if (typeof record.summarize !== "string") return false;
  const summary = record.summarize.trim();
  if (!summary || summary.length < ANALYSIS_SUMMARY_MIN_LENGTH) return false;

  // Validate wiki
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

  // Validate characters (required array, can be empty)
  if (!Array.isArray(record.characters)) return false;
  for (const char of record.characters) {
    if (!char || typeof char !== "object") return false;
    if (typeof char.name !== "string" || !char.name.trim()) return false;
    if (typeof char.kind !== "string") return false;
    if (typeof char.description !== "string") return false;
    if (!Array.isArray(char.traits)) return false;
    if (typeof char.speaking_style !== "string") return false;
    if (!Array.isArray(char.notable_topics)) return false;
    if (!Array.isArray(char.evidence)) return false;
    if (typeof char.voice !== "string") return false;
  }

  // Validate transcript
  if (!record.transcript || typeof record.transcript !== "object") return false;
  const transcript = record.transcript;
  if (typeof transcript.language !== "string") return false;
  if (typeof transcript.is_truncated !== "boolean") return false;
  if (typeof transcript.cursor !== "string") return false;
  if (!Array.isArray(transcript.segments)) return false;
  for (const seg of transcript.segments) {
    if (!seg || typeof seg !== "object") return false;
    if (typeof seg.start !== "string") return false;
    if (typeof seg.end !== "string") return false;
    if (typeof seg.speaker !== "string") return false;
    if (typeof seg.text !== "string") return false;
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
            v.raw
     from videos v
     where v.id = $1`,
    [videoId]
  );

  return result.rows[0] ?? null;
}

/**
 * Update an existing analysis record by ID.
 */
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
         skip_reason = $6,
         updated_at = NOW()
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

function buildRefundIdempotencyKey(jobId: string) {
  return `refund:${jobId}`;
}

async function consumeAnalysisQuota(db: DbPool, params: {
  userId: string;
  videoSeconds: number;
  videoDurationSeconds: number;
  idempotencyKey: string;
  referenceId: string;
  context?: Record<string, unknown> | null;
}) {
  const result = await db.query<{ event_id: string }>(
    `select public.consume_quota(
       $1::uuid,
       $2::bigint,
       $3::bigint,
       $4::bigint,
       $5::text,
       $6::text,
       $7::text,
       $8::text,
       $9::jsonb
     ) as event_id`,
    [
      params.userId,
      params.videoSeconds,
      0,
      params.videoDurationSeconds,
      params.idempotencyKey,
      "video_analysis",
      "video",
      params.referenceId,
      params.context ? JSON.stringify(params.context) : null
    ]
  );

  const eventId = result.rows[0]?.event_id;
  if (!eventId) {
    throw new Error("consume_quota did not return an event id");
  }
  return eventId;
}

async function refundAnalysisQuota(db: DbPool, params: {
  userId: string;
  originalEventId: string;
  idempotencyKey: string;
  reason?: string;
}) {
  const result = await db.query<{ event_id: string }>(
    `select public.refund_quota(
       $1::uuid,
       $2::uuid,
       $3::text,
       $4::text
     ) as event_id`,
    [
      params.userId,
      params.originalEventId,
      params.idempotencyKey,
      params.reason ?? null
    ]
  );

  return result.rows[0]?.event_id ?? null;
}

async function generateGeminiAnalysis(params: {
  apiKey: string;
  model: GeminiModel;
  videoUrl: string;
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

/**
 * Get environment-specific queue name to prevent dev/test/prod queue conflicts.
 * Only development environment gets a prefix to isolate local development.
 */
export function getQueueName(baseName: string, nodeEnv: string): string {
  if (nodeEnv === "development") {
    return `dev.${baseName}`;
  }
  return baseName;
}

export async function registerWorkers(params: {
  boss: PgBoss;
  db: DbPool;
  logger: Logger;
  config: Config;
  instanceId: string;
}) {
  const { boss, db, logger, config } = params;
  const queueName = getQueueName("analyze.video", config.nodeEnv);

  // Ensure queue exists before registering worker
  await boss.createQueue(queueName);
  logger.info({ queueName, nodeEnv: config.nodeEnv }, "Worker queue registered");

  const handleAnalyzeVideoJob = async (job: Job<AnalyzeVideoPayload>) => {
    const payload = job.data;
    const videoId = payload?.videoId;
    const userId = payload?.userId;
    const retryCount = (job as any).retryCount ?? 0;
    const maxRetries = config.analysisJobRetryLimit;

    if (!videoId || !userId) {
      logger.error({ jobId: job.id }, "analyze.video missing required payload");
      throw new Error("analyze.video missing required payload");
    }

    logger.info({ jobId: job.id, videoId, userId, retryCount }, "Analyze video started");

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

    // Use analysisId from payload (already created when enqueuing)
    const analysisId = payload.analysisId;
    if (!analysisId) {
      logger.error({ videoId, userId, jobId: job.id }, "Analyze video missing analysisId in payload");
      throw new Error("analyze.video missing analysisId");
    }

    const durationSec = parseDurationToSeconds(video.duration);
    if (durationSec === null || durationSec <= 0) {
      await updateVideoAnalysis(db, {
        id: analysisId,
        status: ANALYSIS_STATUS.skipped,
        model: config.geminiModel,
        analysisText: "Skipped: duration_invalid",
        usage: null,
        error: null,
        skipReason: "duration_invalid"
      });
      logger.info({ videoId, analysisId }, "Analyze video skipped; duration invalid");
      return { status: ANALYSIS_STATUS.skipped, reason: "duration_invalid", analysisId };
    }

    const model = config.geminiModel;
    const jobId = String(job.id ?? "");
    if (!jobId) {
      logger.error({ videoId, analysisId }, "Analyze video missing job id");
      throw new Error("analyze.video missing job id");
    }


    let quotaEventId: string | null = null;
    const refundQuota = async (reason: string) => {
      if (!quotaEventId) return;
      try {
        await refundAnalysisQuota(db, {
          userId,
          originalEventId: quotaEventId,
          idempotencyKey: buildRefundIdempotencyKey(jobId),
          reason
        });
      } catch (error) {
        logger.error({ videoId, analysisId, err: error }, "Analyze video refund failed");
      }
    };

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
      await refundQuota("config_missing");
      logger.error({ videoId, analysisId }, errorMessage);
      return { status: ANALYSIS_STATUS.failed, analysisId, error: errorMessage };
    }

    try {
      quotaEventId = await consumeAnalysisQuota(db, {
        userId,
        videoSeconds: durationSec,
        videoDurationSeconds: durationSec,
        idempotencyKey: analysisId, // Use analysisId for stable idempotency across retries
        referenceId: videoId,
        context: {
          job_id: jobId,
          analysis_id: analysisId,
          model
        }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "quota_error";
      // Check if this is a business rejection (quota exceeded) vs system failure
      const isQuotaExceeded = errorMessage.includes("insufficient") ||
        errorMessage.includes("exceeded") ||
        errorMessage.includes("quota");

      if (isQuotaExceeded) {
        // Business rejection: skip the job
        await updateVideoAnalysis(db, {
          id: analysisId,
          status: ANALYSIS_STATUS.skipped,
          model,
          analysisText: "Skipped: quota_exceeded",
          usage: null,
          error: null,
          skipReason: "quota_exceeded"
        });
        logger.info(
          { videoId, analysisId, errorMessage },
          "Analyze video skipped; quota exceeded"
        );
        return { status: ANALYSIS_STATUS.skipped, analysisId, reason: "quota_exceeded" };
      } else {
        // System failure: throw for pg-boss retry
        logger.error(
          { videoId, analysisId, err: error, errorMessage },
          "Analyze video failed; quota system error"
        );
        throw error;
      }
    }

    const videoUrl = buildYoutubeVideoUrl(video.youtube_video_id);

    let responseText = "";
    let usage: Record<string, unknown> | null = null;

    try {
      const result = await generateGeminiAnalysis({
        apiKey: config.geminiApiKey,
        model: model as GeminiModel,
        videoUrl
      });
      responseText = result.content;
      usage = result.usage ?? null;
    } catch (error) {
      const { message, status, retryable } = classifyGeminiError(error);

      if (retryable && retryCount < maxRetries) {
        // Let pg-boss handle the retry - keep status as pending
        logger.warn({ videoId, analysisId, status, retryCount, maxRetries, errorMessage: message }, "Analyze video retryable error; will retry");
        throw error;
      }

      // Terminal failure - either not retryable or retries exhausted
      await updateVideoAnalysis(db, {
        id: analysisId,
        status: ANALYSIS_STATUS.failed,
        model,
        analysisText: message,
        usage: null,
        error: message,
        skipReason: null
      });
      await refundQuota(retryCount >= maxRetries ? "retries_exhausted" : "gemini_error");
      captureException(error);
      logger.error({ videoId, analysisId, err: error, errorMessage: message, retryCount }, "Analyze video failed");
      return { status: ANALYSIS_STATUS.failed, analysisId, error: message };
    }

    let parsed: AnalysisOutput;
    try {
      parsed = parseAnalysisOutput(responseText);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "invalid_analysis_output";

      if (retryCount < maxRetries) {
        // Invalid output is retryable - model might return valid JSON on retry
        logger.warn(
          { videoId, analysisId, retryCount, maxRetries, errorMessage },
          "Analyze video response invalid; will retry"
        );
        throw error;
      }

      // Retries exhausted
      await updateVideoAnalysis(db, {
        id: analysisId,
        status: ANALYSIS_STATUS.failed,
        model,
        analysisText: responseText || errorMessage,
        usage,
        error: errorMessage,
        skipReason: null
      });
      await refundQuota("retries_exhausted");
      captureException(error);
      logger.error(
        { videoId, analysisId, retryCount, maxRetries, errorMessage },
        "Analyze video invalid output retries exhausted; refunding quota"
      );
      return { status: ANALYSIS_STATUS.failed, analysisId, error: errorMessage, reason: "retries_exhausted" };
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

  await boss.work<AnalyzeVideoPayload>(queueName, async (jobs) => {
    const jobList = normalizeJobList(jobs);
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
