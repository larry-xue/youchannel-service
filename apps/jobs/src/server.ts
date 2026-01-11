import type { PgBoss } from "pg-boss";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { Config } from "./config.js";
import { createAdminGuard } from "./admin-auth.js";
import type { DbPool } from "./db.js";
import { createServiceKeyGuard } from "./server/guards.js";
import { registerOpenApiRoutes } from "./server/routes/openapi.js";
import { registerAdminVideoRoutes } from "./server/routes/adminVideos.js";
import { registerAdminUserRoutes } from "./server/routes/adminUsers.js";
import { registerAdminSystemUserRoutes } from "./server/routes/adminSystemUsers.js";
import { registerAdminQuotaRoutes } from "./server/routes/adminQuota.js";
import { registerAdminJobRoutes } from "./server/routes/adminJobs.js";

export async function buildServer(params: {
  config: Config;
  logger: Logger;
  boss: PgBoss;
  db: DbPool;
  supabase: SupabaseClient;
}) {
  const { config, logger, boss, db, supabase } = params;
  const app = Fastify({
    logger,
    bodyLimit: 1048576 // 1MB default, but allow empty body
  }) as unknown as FastifyInstance;

  await app.register(cors, {
    origin: process.env.NODE_ENV === "production" ? false : "*",
    credentials: true
  });

  const adminDistPath = join(process.cwd(), "../admin/dist");

  await app.register(fastifyStatic, {
    root: adminDistPath,
    prefix: "/"
  });

  const requireAdmin = createAdminGuard(supabase);
  const requireServiceKey = createServiceKeyGuard(config);

  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    try {
      if (body === "" || body === "{}" || !body) {
        done(null, {});
      } else {
        const json = JSON.parse(body as string);
        done(null, json);
      }
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get("/health", async () => ({ ok: true }));

  registerOpenApiRoutes(app, { boss, db, config, requireServiceKey });
  registerAdminVideoRoutes(app, { db, boss, config, requireAdmin });
  registerAdminUserRoutes(app, { supabase, requireAdmin });
  registerAdminSystemUserRoutes(app, { supabase, requireAdmin });
  registerAdminQuotaRoutes(app, { supabase, requireAdmin });
  registerAdminJobRoutes(app, { db, requireAdmin });

  app.setNotFoundHandler(async (request, reply) => {
    if (
      request.url.startsWith("/admin/") ||
      request.url.startsWith("/openapi/") ||
      request.url.startsWith("/health")
    ) {
      reply.code(404);
      return { error: "not_found" };
    }
    try {
      const indexPath = join(adminDistPath, "index.html");
      const indexContent = readFileSync(indexPath, "utf-8");
      reply.type("text/html");
      return indexContent;
    } catch (error) {
      logger.error({ err: error }, "Failed to serve index.html");
      reply.code(500);
      return { error: "Internal server error" };
    }
  });

  return app;
}
