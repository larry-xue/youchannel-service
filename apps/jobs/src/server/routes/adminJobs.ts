import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DbPool } from "@jobs/db";
import { parseLimit, parseOffset, parseOptionalQueryString } from "@jobs/server/utils";

type Deps = {
  db: DbPool;
  requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void> | void;
};

export function registerAdminJobRoutes(app: FastifyInstance, deps: Deps) {
  app.get("/admin/jobs", { preHandler: deps.requireAdmin }, async () => {
    const result = await deps.db.query<{ name: string; state: string; count: string }>(
      `SELECT name, state, COUNT(*)::text as count
       FROM pgboss.job
       GROUP BY name, state
       ORDER BY name, state`
    );

    const stats: Record<string, number> = {};
    let total = 0;
    for (const row of result.rows) {
      const count = parseInt(row.count, 10);
      stats[row.state] = count;
      total += count;
    }

    return {
      queueName: "video.analysis",
      stats,
      total
    };
  });

  app.get("/admin/jobs/list", { preHandler: deps.requireAdmin }, async (request, reply) => {
    const query = request.query as Record<string, string | string[] | undefined>;
    const state = parseOptionalQueryString(query.state);
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

    const effectiveLimit = Math.min(limit ?? 50, 100);
    const effectiveOffset = offset ?? 0;

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIndex = 1;

    if (state) {
      conditions.push(`state = $${paramIndex}`);
      params.push(state);
      paramIndex++;
    }

    params.push(effectiveLimit, effectiveOffset);

    const whereClause = conditions.length > 0 ? conditions.join(" AND ") : "1=1";
    const result = await deps.db.query<{
      id: string;
      name: string;
      state: string;
      data: Record<string, unknown> | null;
      output: Record<string, unknown> | null;
      created_on: string;
      started_on: string | null;
      completed_on: string | null;
      retry_count: number;
    }>(
      `SELECT id, name, state, data, output, created_on, started_on, completed_on, retry_count
       FROM pgboss.job
       WHERE ${whereClause}
       ORDER BY created_on DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      params
    );

    const countResult = await deps.db.query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM pgboss.job WHERE ${whereClause}`,
      state ? [state] : []
    );

    return {
      rows: result.rows,
      total: parseInt(countResult.rows[0]?.count ?? "0", 10),
      limit: effectiveLimit,
      offset: effectiveOffset
    };
  });
}
