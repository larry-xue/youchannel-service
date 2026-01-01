import type { PgBoss } from "pg-boss";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import Fastify from "fastify";
import cors from "@fastify/cors";
import type { Config } from "./config";
import { createAdminGuard } from "./admin-auth";
import { listJobRuns, listSyncRuns, type DbPool } from "./db";

export async function buildServer(params: {
  config: Config;
  logger: Logger;
  boss: PgBoss;
  db: DbPool;
  supabase: SupabaseClient;
}) {
  const { config, logger, boss, db, supabase } = params;
  const app = Fastify({ logger });

  await app.register(cors, {
    origin: config.adminOrigin,
    credentials: true
  });

  const requireAdmin = createAdminGuard(supabase);

  app.get("/health", async () => ({ ok: true }));

  app.post("/admin/kickoff", { preHandler: requireAdmin }, async (request) => {
    const bossJobId = await boss.publish("kickoff", {
      source: "manual",
      requestedBy: request.adminUser?.id
    });

    return { bossJobId };
  });

  app.get("/admin/sync-runs", { preHandler: requireAdmin }, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? 50);
    const rows = await listSyncRuns(db, Number.isFinite(limit) ? limit : 50);
    return { rows };
  });

  app.get("/admin/job-runs", { preHandler: requireAdmin }, async (request) => {
    const query = request.query as { syncRunId?: string; limit?: string };
    const limit = Number(query.limit ?? 50);
    const rows = await listJobRuns(db, {
      syncRunId: query.syncRunId,
      limit: Number.isFinite(limit) ? limit : 50
    });
    return { rows };
  });

  return app;
}