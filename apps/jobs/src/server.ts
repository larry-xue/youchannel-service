import type { PgBoss } from "pg-boss";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Logger } from "pino";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { Config } from "./config.js";
import { enqueueAnalyses, fetchAnalysisCandidates } from "./analysis.js";
import { createAdminGuard } from "./admin-auth.js";
import {
  getJobRunById,
  getPlaylistForAnalysis,
  listAdminVideos,
  listJobRuns,
  listSyncRuns,
  updateJobRunById,
  type DbPool
} from "./db.js";
import { buildSyncPlaylistJobOptions } from "./queue.js";

type YoutubeAccountRow = {
  id: string;
  user_id: string;
  provider: string;
  scope: string | null;
  token_type: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  access_token: string | null;
  refresh_token: string | null;
};

type YoutubeAccountSummary = {
  id: string;
  provider: string;
  scope: string | null;
  token_type: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  has_access_token: boolean;
  has_refresh_token: boolean;
};

type SystemUserRow = {
  id: string;
  email: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  youtube_accounts: YoutubeAccountSummary[];
};

function parseTimestamp(value: string | null | undefined) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function readHeaderValue(value: string | string[] | undefined) {
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function extractServiceKey(headers: Record<string, string | string[] | undefined>) {
  const direct =
    readHeaderValue(headers["x-openapi-key"]) ??
    readHeaderValue(headers["x-api-key"]) ??
    readHeaderValue(headers["x-service-key"]);
  if (direct) return direct;

  const auth = readHeaderValue(headers.authorization);
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }

  return undefined;
}

function parseRequiredString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseOptionalQueryString(value: string | string[] | undefined) {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseStringArray(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return null;
  const items = value.map((item) => (typeof item === "string" ? item.trim() : ""));
  if (items.some((item) => item.length === 0)) return null;
  return items;
}

function normalizeUnique(values?: string[] | null) {
  if (!values) return values;
  return Array.from(new Set(values));
}

function parseLimit(value: unknown) {
  if (value === undefined || value === null) return undefined;
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return Math.trunc(limit);
}

function parseOffset(value: unknown) {
  if (value === undefined || value === null) return undefined;
  const offset = Number(value);
  if (!Number.isFinite(offset) || offset < 0) return null;
  return Math.trunc(offset);
}

function buildAccountSummary(row: YoutubeAccountRow): YoutubeAccountSummary {
  return {
    id: row.id,
    provider: row.provider,
    scope: row.scope ?? null,
    token_type: row.token_type ?? null,
    expires_at: row.expires_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    has_access_token: Boolean(row.access_token),
    has_refresh_token: Boolean(row.refresh_token)
  };
}

async function listAllAuthUsers(supabase: SupabaseClient, perPage = 200) {
  const users: User[] = [];
  let page = 1;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw error;
    }

    const batch = data?.users ?? [];
    users.push(...batch);

    if (batch.length < perPage) {
      break;
    }

    page += 1;
  }

  return users;
}

async function listAllYoutubeAccounts(supabase: SupabaseClient, pageSize = 1000) {
  const rows: YoutubeAccountRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("youtube_accounts")
      .select(
        "id,user_id,provider,scope,token_type,expires_at,created_at,updated_at,access_token,refresh_token"
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (error) {
      throw error;
    }

    const batch = (data ?? []) as YoutubeAccountRow[];
    rows.push(...batch);

    if (batch.length < pageSize) {
      break;
    }

    offset += pageSize;
  }

  return rows;
}

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
    origin: process.env.NODE_ENV === "production" ? false : "*",
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
  const requireServiceKey = async (request: any, reply: any) => {
    if (!config.openapiSharedKey) {
      reply.code(503).send({ error: "service_unavailable" });
      return;
    }

    const key = extractServiceKey(request.headers as Record<string, string | string[] | undefined>);
    if (!key || key !== config.openapiSharedKey) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
  };

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

  app.post("/openapi/analysis", { preHandler: requireServiceKey }, async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    const playlistId = parseRequiredString(body?.playlistId);
    const userId = parseRequiredString(body?.userId);
    const videoIds = normalizeUnique(parseStringArray(body?.videoIds));
    const limit = parseLimit(body?.limit);

    if (!playlistId || !userId) {
      reply.code(400);
      return { error: "missing_playlist_or_user" };
    }

    if (videoIds === null) {
      reply.code(400);
      return { error: "invalid_video_ids" };
    }

    if (limit === null) {
      reply.code(400);
      return { error: "invalid_limit" };
    }

    const playlist = await getPlaylistForAnalysis(db, playlistId);
    if (!playlist) {
      reply.code(404);
      return { error: "playlist_not_found" };
    }

    if (playlist.user_id !== userId) {
      reply.code(403);
      return { error: "forbidden" };
    }

    const candidates = await fetchAnalysisCandidates(db, {
      playlistId,
      videoIds,
      limit
    });

    if (videoIds && candidates.length !== videoIds.length) {
      reply.code(403);
      return { error: "video_forbidden" };
    }

    const result = await enqueueAnalyses({
      boss,
      db,
      userId,
      playlistId,
      prompt: playlist.analysis_prompt,
      model: config.geminiModel,
      candidates
    });

    return {
      playlistId,
      userId,
      candidateCount: candidates.length,
      enqueued: result.enqueued,
      skipped: result.skipped,
      skipReasons: result.skipReasons
    };
  });

  app.get("/admin/sync-runs", { preHandler: requireAdmin }, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? 50);
    const rows = await listSyncRuns(db, Number.isFinite(limit) ? limit : 50);
    return { rows };
  });

  app.get("/admin/videos", { preHandler: requireAdmin }, async (request, reply) => {
    const query = request.query as Record<string, string | string[] | undefined>;
    const userId = parseOptionalQueryString(query.userId);
    const syncStatus = parseOptionalQueryString(query.syncStatus);
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

    const allowedStatuses = new Set(["synced", "removed", "unavailable"]);
    if (syncStatus && !allowedStatuses.has(syncStatus)) {
      reply.code(400);
      return { error: "invalid_sync_status" };
    }

    const rows = await listAdminVideos(db, {
      userId,
      syncStatus,
      limit: limit ?? 50,
      offset: offset ?? 0
    });

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

  app.post("/admin/analysis", { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    const playlistId = parseRequiredString(body?.playlistId);
    const userId = parseRequiredString(body?.userId);
    const videoIds = normalizeUnique(parseStringArray(body?.videoIds));
    const limit = parseLimit(body?.limit);

    if (!playlistId) {
      reply.code(400);
      return { error: "missing_playlist" };
    }

    if (videoIds === null) {
      reply.code(400);
      return { error: "invalid_video_ids" };
    }

    if (limit === null) {
      reply.code(400);
      return { error: "invalid_limit" };
    }

    const playlist = await getPlaylistForAnalysis(db, playlistId);
    if (!playlist) {
      reply.code(404);
      return { error: "playlist_not_found" };
    }

    if (userId && playlist.user_id !== userId) {
      reply.code(400);
      return { error: "user_mismatch" };
    }

    const actingUserId = userId ?? playlist.user_id;
    const candidates = await fetchAnalysisCandidates(db, {
      playlistId,
      videoIds,
      limit
    });

    if (videoIds && candidates.length !== videoIds.length) {
      reply.code(400);
      return { error: "video_mismatch" };
    }

    const result = await enqueueAnalyses({
      boss,
      db,
      userId: actingUserId,
      playlistId,
      prompt: playlist.analysis_prompt,
      model: config.geminiModel,
      candidates
    });

    return {
      playlistId,
      userId: actingUserId,
      candidateCount: candidates.length,
      enqueued: result.enqueued,
      skipped: result.skipped,
      skipReasons: result.skipReasons
    };
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

  app.get("/admin/system-users", { preHandler: requireAdmin }, async () => {
    const [users, youtubeAccounts] = await Promise.all([
      listAllAuthUsers(supabase),
      listAllYoutubeAccounts(supabase)
    ]);

    const accountsByUser = new Map<string, YoutubeAccountSummary[]>();
    for (const account of youtubeAccounts) {
      const summary = buildAccountSummary(account);
      const existing = accountsByUser.get(account.user_id);
      if (existing) {
        existing.push(summary);
      } else {
        accountsByUser.set(account.user_id, [summary]);
      }
    }

    const rows: SystemUserRow[] = users.map((user) => ({
      id: user.id,
      email: user.email ?? null,
      created_at: user.created_at,
      last_sign_in_at: user.last_sign_in_at ?? null,
      youtube_accounts: accountsByUser.get(user.id) ?? []
    }));

    rows.sort((a, b) => parseTimestamp(b.created_at) - parseTimestamp(a.created_at));

    return { rows };
  });

  // SPA 回退路由：所有非 API 路由都返回 index.html
  app.setNotFoundHandler(async (request, reply) => {
    // 如果是 API 路由（以 /admin/ 或 /health 开头），返回 404
    if (request.url.startsWith("/admin/") || request.url.startsWith("/openapi/") || request.url.startsWith("/health")) {
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
