import type { PgBoss } from "pg-boss";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { Config } from "./config";
import { createAdminGuard } from "./admin-auth";
import { getJobRunById, listJobRuns, listSyncRuns, updateJobRunById, type DbPool } from "./db";
import { buildSyncPlaylistJobOptions } from "./queue";

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
  });

  await app.register(cors, {
    origin: config.adminOrigin,
    credentials: true
  });

  // 提供 admin 前端的静态文件服务
  // 在运行时，工作目录是 /app/apps/jobs
  // admin/dist 在 /app/apps/admin/dist，所以相对路径是 ../admin/dist
  const adminDistPath = join(process.cwd(), "../admin/dist");
  
  await app.register(fastifyStatic, {
    root: adminDistPath,
    prefix: "/" // 在根路径提供静态文件
  });

  const requireAdmin = createAdminGuard(supabase);

  // Add custom content type parser to handle empty JSON body
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

  app.post(
    "/admin/kickoff-sync",
    {
      preHandler: requireAdmin
    },
    async (request) => {
      const bossJobId = await boss.send("kickoff", {
        source: "admin-manual",
        requestedBy: request.adminUser?.id
      });

      return { bossJobId };
    }
  );

  app.get("/admin/sync-runs", { preHandler: requireAdmin }, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? 50);
    const rows = await listSyncRuns(db, Number.isFinite(limit) ? limit : 50);
    return { rows };
  });

  app.get("/admin/sync-runs/:id/job-runs", { preHandler: requireAdmin }, async (request) => {
    const params = request.params as { id: string };
    const limit = Number((request.query as { limit?: string }).limit ?? 50);
    const rows = await listJobRuns(db, {
      syncRunId: params.id,
      limit: Number.isFinite(limit) ? limit : 50
    });
    return { rows };
  });

  app.post("/admin/job-runs/:id/retry", { preHandler: requireAdmin }, async (request, reply) => {
    const params = request.params as { id: string };
    const jobRun = await getJobRunById(db, params.id);

    if (!jobRun) {
      reply.code(404);
      return { error: "not_found" };
    }

    if (!jobRun.playlist_id) {
      reply.code(400);
      return { error: "missing_playlist" };
    }

    const bossJobId = await boss.send(
      "sync.playlist",
      {
        syncRunId: jobRun.sync_run_id,
        playlistId: jobRun.playlist_id,
        userId: jobRun.user_id,
        jobRunId: jobRun.id
      },
      buildSyncPlaylistJobOptions(jobRun.playlist_id)
    );

    if (!bossJobId) {
      reply.code(409);
      return { error: "deduped" };
    }

    await updateJobRunById(db, jobRun.id, {
      status: "queued",
      startedAt: null,
      finishedAt: null,
      error: null,
      result: null,
      bossJobId
    });

    return { bossJobId };
  });

  // Admin users management
  app.get("/admin/users", { preHandler: requireAdmin }, async () => {
    // Use service role to query admin_users and join with auth.users
    const { data, error } = await supabase
      .from("admin_users")
      .select(`
        user_id,
        created_at
      `)
      .order("created_at", { ascending: false });

    if (error) {
      throw error;
    }

    // Get user emails from auth.users using admin API
    const { data: allUsers } = await supabase.auth.admin.listUsers();
    const userMap = new Map(allUsers.users.map((u) => [u.id, u.email]));

    return {
      rows: data.map((row: any) => ({
        user_id: row.user_id,
        created_at: row.created_at,
        email: userMap.get(row.user_id) || null
      }))
    };
  });

  app.post("/admin/users", { preHandler: requireAdmin }, async (request) => {
    const body = request.body as { email: string; password?: string; createIfNotExists?: boolean };
    if (!body.email) {
      return { error: "email is required" };
    }

    // Find user by email using admin API
    const { data: users, error: userError } = await supabase.auth.admin.listUsers();
    if (userError) {
      throw userError;
    }

    let user = users.users.find((u) => u.email?.toLowerCase() === body.email.toLowerCase());

    // Create user if not exists and password provided
    if (!user && body.createIfNotExists && body.password) {
      const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
        email: body.email,
        password: body.password,
        email_confirm: true
      });

      if (createError) {
        return { error: `Failed to create user: ${createError.message}` };
      }

      user = newUser.user;
    }

    if (!user) {
      return { error: "User not found. Set createIfNotExists=true and provide password to create user." };
    }

    // Add to admin_users (using service role)
    const { data, error } = await supabase
      .from("admin_users")
      .insert({ user_id: user.id })
      .select()
      .single();

    if (error) {
      // Check if already exists
      if (error.code === "23505") {
        return { error: "User is already an admin" };
      }
      throw error;
    }

    return { success: true, data };
  });

  app.delete("/admin/users/:userId", { preHandler: requireAdmin }, async (request) => {
    const { userId } = request.params as { userId: string };
    const currentUserId = request.adminUser?.id;

    // Prevent self-deletion
    if (userId === currentUserId) {
      return { error: "Cannot remove yourself" };
    }

    const { error } = await supabase
      .from("admin_users")
      .delete()
      .eq("user_id", userId);

    if (error) {
      throw error;
    }

    return { success: true };
  });

  // SPA 回退路由：所有非 API 路由都返回 index.html
  app.setNotFoundHandler(async (request, reply) => {
    // 如果是 API 路由（以 /admin/ 或 /health 开头），返回 404
    if (request.url.startsWith("/admin/") || request.url.startsWith("/health")) {
      reply.code(404);
      return { error: "not_found" };
    }
    // 否则返回前端 index.html（用于 SPA 路由）
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
