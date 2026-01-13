import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PgBoss } from "pg-boss";
import type { Config } from "@jobs/config";
import type { DbPool } from "@jobs/db";
import { enqueueAnalyses, fetchAnalysisCandidates } from "@jobs/analysis";
import { listAdminVideos, fetchVideoAnalyses, deleteVideoAnalysis } from "@jobs/db";
import {
  parseLimit,
  parseOffset,
  parseOptionalQueryString,
  parseStringArray,
  parseRequiredString,
  normalizeUnique
} from "@jobs/server/utils";

type Deps = {
  db: DbPool;
  boss: PgBoss;
  config: Config;
  requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void> | void;
};

export function registerAdminVideoRoutes(app: FastifyInstance, deps: Deps) {
  app.get("/admin/videos", { preHandler: deps.requireAdmin }, async (request, reply) => {
    const query = request.query as Record<string, string | string[] | undefined>;
    const userId = parseOptionalQueryString(query.userId);
    const limit = parseLimit(query.limit);
    const offset = parseOffset(query.offset);

    if (limit === null) {
      reply.code(400);
      return { error: "invalid_limit" };
    }

    if (offset === null) {
      reply.code(400);
      return { error: "invalid_offset" };
    }

    const rows = await listAdminVideos(deps.db, {
      userId: userId ?? "",
      limit: limit ?? 50,
      offset: offset ?? 0
    });

    return { rows };
  });

  app.get(
    "/admin/videos/:videoId/analyses",
    { preHandler: deps.requireAdmin },
    async (request, reply) => {
      const { videoId } = request.params as { videoId: string };

      if (!videoId) {
        reply.code(400);
        return { error: "missing_video_id" };
      }

      const analyses = await fetchVideoAnalyses(deps.db, videoId);
      return { analyses };
    }
  );

  app.post("/admin/analysis", { preHandler: deps.requireAdmin }, async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    const userId = parseRequiredString(body?.userId);
    const videoIds = normalizeUnique(parseStringArray(body?.videoIds));
    const limit = parseLimit(body?.limit);

    if (!userId) {
      reply.code(400);
      return { error: "missing_user" };
    }

    if (videoIds === null) {
      reply.code(400);
      return { error: "invalid_video_ids" };
    }

    if (limit === null) {
      reply.code(400);
      return { error: "invalid_limit" };
    }

    const candidates = await fetchAnalysisCandidates(deps.db, {
      userId,
      videoIds,
      limit
    });

    if (videoIds && candidates.length !== videoIds.length) {
      reply.code(400);
      return { error: "video_mismatch" };
    }

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
      candidateCount: candidates.length,
      enqueued: result.enqueued,
      skipped: result.skipped,
      skipReasons: result.skipReasons
    };
  });

  app.delete(
    "/admin/analyses/:analysisId",
    { preHandler: deps.requireAdmin },
    async (request, reply) => {
      const { analysisId } = request.params as { analysisId: string };

      if (!analysisId) {
        reply.code(400);
        return { error: "missing_analysis_id" };
      }

      const deleted = await deleteVideoAnalysis(deps.db, analysisId);
      if (!deleted) {
        reply.code(404);
        return { error: "analysis_not_found" };
      }

      return { success: true };
    }
  );
}
