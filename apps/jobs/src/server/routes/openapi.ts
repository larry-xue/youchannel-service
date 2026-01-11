import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PgBoss } from "pg-boss";
import type { Config } from "../../config.js";
import type { DbPool } from "../../db.js";
import { enqueueAnalyses } from "../../analysis.js";
import { parseRequiredString } from "../utils.js";

type OpenApiVideoInput = {
  youtubeVideoId: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  publishedAt: string;
  duration: string;
  url: string;
  raw: Record<string, unknown> | null;
};

type InsertedVideoRow = {
  id: string;
  youtube_video_id: string;
  duration: string | null;
};

const parseDurationToSeconds = (value: string) => {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
};

function parseRequiredTimestamp(value: unknown) {
  const raw = parseRequiredString(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : raw;
}

function parseOptionalJsonRecord(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function parseRequiredDuration(value: unknown) {
  const raw = parseRequiredString(value);
  if (!raw) return null;
  const seconds = parseDurationToSeconds(raw);
  if (seconds === null || seconds <= 0) return null;
  return raw;
}

function parseOpenApiVideoInput(value: unknown): OpenApiVideoInput | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const youtubeVideoId = parseRequiredString(record.youtubeVideoId);
  const title = parseRequiredString(record.title);
  const description = parseRequiredString(record.description);
  const thumbnailUrl = parseRequiredString(record.thumbnailUrl);
  const publishedAt = parseRequiredTimestamp(record.publishedAt);
  const duration = parseRequiredDuration(record.duration);
  const url = parseRequiredString(record.url);
  const raw = parseOptionalJsonRecord(record.raw);

  if (
    !youtubeVideoId ||
    !title ||
    !description ||
    !thumbnailUrl ||
    !publishedAt ||
    !duration ||
    !url ||
    raw === undefined
  ) {
    return null;
  }

  return {
    youtubeVideoId,
    title,
    description,
    thumbnailUrl,
    publishedAt,
    duration,
    url,
    raw
  };
}

async function insertOpenApiVideos(
  db: DbPool,
  userId: string,
  videos: OpenApiVideoInput[]
): Promise<InsertedVideoRow[]> {
  if (videos.length === 0) return [];

  const columns = [
    "user_id",
    "youtube_video_id",
    "title",
    "description",
    "thumbnail_url",
    "published_at",
    "duration",
    "url",
    "raw"
  ];

  const values: Array<string | Record<string, unknown> | null> = [];
  const placeholders = videos.map((video, index) => {
    const base = index * columns.length;
    values.push(
      userId,
      video.youtubeVideoId,
      video.title,
      video.description,
      video.thumbnailUrl,
      video.publishedAt,
      video.duration,
      video.url,
      video.raw
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
  });

  const result = await db.query<InsertedVideoRow>(
    `insert into videos (${columns.join(", ")})
     values ${placeholders.join(", ")}
     on conflict (user_id, youtube_video_id) do nothing
     returning id, youtube_video_id, duration`,
    values
  );

  return result.rows;
}

type Deps = {
  boss: PgBoss;
  db: DbPool;
  config: Config;
  requireServiceKey: (request: FastifyRequest, reply: FastifyReply) => Promise<void> | void;
};

export function registerOpenApiRoutes(app: FastifyInstance, deps: Deps) {
  app.post("/openapi/analysis", { preHandler: deps.requireServiceKey }, async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    const userId = parseRequiredString(body?.userId);
    const videosInput = body?.videos;

    if (!userId) {
      reply.code(400);
      return { error: "missing_user" };
    }

    if (!Array.isArray(videosInput) || videosInput.length === 0) {
      reply.code(400);
      return { error: "missing_videos" };
    }

    const parsedVideos = videosInput.map(parseOpenApiVideoInput);
    if (parsedVideos.some((video) => !video)) {
      reply.code(400);
      return { error: "invalid_videos" };
    }

    const uniqueMap = new Map<string, OpenApiVideoInput>();
    for (const video of parsedVideos as OpenApiVideoInput[]) {
      if (!uniqueMap.has(video.youtubeVideoId)) {
        uniqueMap.set(video.youtubeVideoId, video);
      }
    }

    const uniqueVideos = Array.from(uniqueMap.values());
    const requestedCount = videosInput.length;
    const uniqueCount = uniqueVideos.length;

    const insertedRows = await insertOpenApiVideos(deps.db, userId, uniqueVideos);
    const insertedCount = insertedRows.length;
    const existingCount = uniqueCount - insertedCount;

    const candidates = insertedRows.map((row) => ({
      videoId: row.id,
      youtubeVideoId: row.youtube_video_id,
      durationSec: row.duration ? parseDurationToSeconds(row.duration) : null
    }));

    const result = await enqueueAnalyses({
      boss: deps.boss,
      db: deps.db,
      config: deps.config,
      userId,
      model: deps.config.geminiModel,
      candidates
    });

    return {
      userId,
      requestedCount,
      uniqueCount,
      insertedCount,
      existingCount,
      enqueued: result.enqueued,
      skipped: result.skipped,
      skipReasons: result.skipReasons
    };
  });
}
