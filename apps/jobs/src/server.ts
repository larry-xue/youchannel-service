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
  listAdminVideos,
  type DbPool
} from "./db.js";

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

type UserQuotaInfo = {
  video_seconds_total: number;
  video_seconds_remaining: number;
  chat_seconds_total: number;
  chat_seconds_remaining: number;
  max_video_seconds: number;
  period_start_at: string | null;
  period_end_at: string | null;
} | null;

type SystemUserRow = {
  id: string;
  email: string | null;
  phone: string | null;
  created_at: string;
  confirmed_at: string | null;
  email_confirmed_at: string | null;
  phone_confirmed_at: string | null;
  last_sign_in_at: string | null;
  role: string | null;
  aud: string | null;
  app_metadata: Record<string, unknown> | null;
  user_metadata: Record<string, unknown> | null;
  is_anonymous: boolean;
  youtube_accounts: YoutubeAccountSummary[];
  quota: UserQuotaInfo;
};

const DEFAULT_ANALYSIS_PROMPT =
  "Summarize the video in 5 bullet points and call out key insights.";

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

function parseOptionalString(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

  // Provide admin frontend static files
  const adminDistPath = join(process.cwd(), "../admin/dist");

  await app.register(fastifyStatic, {
    root: adminDistPath,
    prefix: "/" // Serve static files at root
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
    const userId = parseRequiredString(body?.userId);
    const videoIds = normalizeUnique(parseStringArray(body?.videoIds));
    const limit = parseLimit(body?.limit);
    const prompt = parseOptionalString(body?.prompt) ?? DEFAULT_ANALYSIS_PROMPT;

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

    const candidates = await fetchAnalysisCandidates(db, {
      userId,
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
      prompt,
      model: config.geminiModel,
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

  app.get("/admin/videos", { preHandler: requireAdmin }, async (request, reply) => {
    const query = request.query as Record<string, string | string[] | undefined>;
    const userId = parseOptionalQueryString(query.userId);
    const status = parseOptionalQueryString(query.status);
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

    const allowedStatuses = new Set(["pending", "active", "error"]);
    if (status && !allowedStatuses.has(status)) {
      reply.code(400);
      return { error: "invalid_status" };
    }

    const rows = await listAdminVideos(db, {
      userId,
      status,
      limit: limit ?? 50,
      offset: offset ?? 0
    });

    return { rows };
  });

  app.post("/admin/analysis", { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    const userId = parseRequiredString(body?.userId);
    const videoIds = normalizeUnique(parseStringArray(body?.videoIds));
    const limit = parseLimit(body?.limit);
    const prompt = parseOptionalString(body?.prompt) ?? DEFAULT_ANALYSIS_PROMPT;

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

    const candidates = await fetchAnalysisCandidates(db, {
      userId,
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
      userId,
      prompt,
      model: config.geminiModel,
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

  // Admin users management
  app.get("/admin/users", { preHandler: requireAdmin }, async () => {
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

    const { data: userList, error: userError } = await supabase.auth.admin.listUsers({
      page: 1,
      perPage: 1000
    });

    if (userError) {
      throw userError;
    }

    const userMap = new Map(userList.users.map((user) => [user.id, user]));

    return {
      rows: data.map((row: any) => {
        const user = userMap.get(row.user_id);
        const identities =
          user?.identities?.map((identity: any) => ({
            id: identity.id,
            provider: identity.provider,
            identity_data: identity.identity_data ?? null,
            user_id: identity.user_id
          })) ?? [];

        return {
          user_id: row.user_id,
          created_at: row.created_at,
          email: user?.email ?? null,
          user_created_at: user?.created_at ?? null,
          last_sign_in_at: user?.last_sign_in_at ?? null,
          confirmed_at: user?.confirmed_at ?? null,
          email_confirmed_at: user?.email_confirmed_at ?? null,
          phone: user?.phone ?? null,
          phone_confirmed_at: user?.phone_confirmed_at ?? null,
          role: user?.role ?? null,
          aud: user?.aud ?? null,
          app_metadata: user?.app_metadata ?? null,
          user_metadata: user?.user_metadata ?? null,
          identities
        };
      })
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

  app.get("/admin/system-users", { preHandler: requireAdmin }, async (request, reply) => {
    const query = request.query as Record<string, string | string[] | undefined>;
    const email = parseOptionalQueryString(query.email);
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

    const [users, youtubeAccounts, quotasResult] = await Promise.all([
      listAllAuthUsers(supabase),
      listAllYoutubeAccounts(supabase),
      supabase
        .from("user_quotas")
        .select(
          "user_id, video_seconds_total, video_seconds_remaining, chat_seconds_total, chat_seconds_remaining, max_video_seconds, period_start_at, period_end_at"
        )
    ]);

    if (quotasResult.error) {
      throw quotasResult.error;
    }

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

    const quotasByUser = new Map<string, UserQuotaInfo>();
    for (const quota of quotasResult.data ?? []) {
      quotasByUser.set(quota.user_id, {
        video_seconds_total: quota.video_seconds_total,
        video_seconds_remaining: quota.video_seconds_remaining,
        chat_seconds_total: quota.chat_seconds_total,
        chat_seconds_remaining: quota.chat_seconds_remaining,
        max_video_seconds: quota.max_video_seconds,
        period_start_at: quota.period_start_at ?? null,
        period_end_at: quota.period_end_at ?? null
      });
    }

    let filteredUsers = users;

    // Filter by email (case-insensitive contains)
    if (email) {
      const lowerEmail = email.toLowerCase();
      filteredUsers = filteredUsers.filter(
        (user) => user.email?.toLowerCase().includes(lowerEmail)
      );
    }

    // Sort by created_at descending
    filteredUsers.sort((a, b) => parseTimestamp(b.created_at) - parseTimestamp(a.created_at));

    const total = filteredUsers.length;
    const effectiveLimit = limit ?? 20;
    const effectiveOffset = offset ?? 0;

    // Paginate
    const paginatedUsers = filteredUsers.slice(effectiveOffset, effectiveOffset + effectiveLimit);

    const rows: SystemUserRow[] = paginatedUsers.map((user) => ({
      id: user.id,
      email: user.email ?? null,
      phone: user.phone ?? null,
      created_at: user.created_at,
      confirmed_at: user.confirmed_at ?? null,
      email_confirmed_at: user.email_confirmed_at ?? null,
      phone_confirmed_at: user.phone_confirmed_at ?? null,
      last_sign_in_at: user.last_sign_in_at ?? null,
      role: user.role ?? null,
      aud: user.aud ?? null,
      app_metadata: user.app_metadata ?? null,
      user_metadata: user.user_metadata ?? null,
      is_anonymous: user.is_anonymous ?? false,
      youtube_accounts: accountsByUser.get(user.id) ?? [],
      quota: quotasByUser.get(user.id) ?? null
    }));

    return { rows, total };
  });

  // Quota admin API endpoints
  
  // GET /admin/quota/:userId - Get user quota details
  app.get("/admin/quota/:userId", { preHandler: requireAdmin }, async (request, reply) => {
    const { userId } = request.params as { userId: string };

    // Get user_quotas cache
    const { data: quotaCache, error: quotaCacheError } = await supabase
      .from("user_quotas")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (quotaCacheError) {
      throw quotaCacheError;
    }

    // Get active grants
    const { data: grants, error: grantsError } = await supabase
      .from("quota_grants")
      .select("*")
      .eq("user_id", userId)
      .order("consume_priority", { ascending: true })
      .order("valid_to", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });

    if (grantsError) {
      throw grantsError;
    }

    // Get recent usage events
    const { data: events, error: eventsError } = await supabase
      .from("quota_usage_events")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (eventsError) {
      throw eventsError;
    }

    // Get user info
    const { data: userData, error: userError } = await supabase.auth.admin.getUserById(userId);
    
    return {
      user: userError ? null : {
        id: userData.user.id,
        email: userData.user.email ?? null
      },
      quotaCache: quotaCache ?? null,
      grants: grants ?? [],
      events: events ?? []
    };
  });

  // POST /admin/quota/grants - Add grant for user
  app.post("/admin/quota/grants", { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    
    const userId = parseRequiredString(body?.userId);
    const videoSecondsTotal = parseLimit(body?.videoSecondsTotal);
    const chatSecondsTotal = parseLimit(body?.chatSecondsTotal);
    const maxVideoSeconds = parseLimit(body?.maxVideoSeconds);
    const sourceType = parseOptionalString(body?.sourceType) ?? "manual";
    const sourceRef = parseOptionalString(body?.sourceRef);
    const validTo = parseOptionalString(body?.validTo);
    const consumePriority = parseLimit(body?.consumePriority);

    if (!userId) {
      reply.code(400);
      return { error: "missing_user_id" };
    }

    if (videoSecondsTotal === null || videoSecondsTotal === undefined) {
      reply.code(400);
      return { error: "missing_video_seconds_total" };
    }

    if (chatSecondsTotal === null || chatSecondsTotal === undefined) {
      reply.code(400);
      return { error: "missing_chat_seconds_total" };
    }

    if (maxVideoSeconds === null || maxVideoSeconds === undefined) {
      reply.code(400);
      return { error: "missing_max_video_seconds" };
    }

    const allowedSourceTypes = ["manual", "promo", "subscription", "package"];
    if (!allowedSourceTypes.includes(sourceType)) {
      reply.code(400);
      return { error: "invalid_source_type" };
    }

    const { data, error } = await supabase
      .from("quota_grants")
      .insert({
        user_id: userId,
        source_type: sourceType,
        source_ref: sourceRef ?? null,
        video_seconds_total: videoSecondsTotal,
        video_seconds_remaining: videoSecondsTotal,
        chat_seconds_total: chatSecondsTotal,
        chat_seconds_remaining: chatSecondsTotal,
        max_video_seconds: maxVideoSeconds,
        valid_to: validTo ?? null,
        consume_priority: consumePriority ?? 100
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    return { success: true, grant: data };
  });

  // POST /admin/quota/refund - Issue refund via RPC
  app.post("/admin/quota/refund", { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    
    const userId = parseRequiredString(body?.userId);
    const originalEventId = parseRequiredString(body?.originalEventId);
    const reason = parseOptionalString(body?.reason);

    if (!userId) {
      reply.code(400);
      return { error: "missing_user_id" };
    }

    if (!originalEventId) {
      reply.code(400);
      return { error: "missing_original_event_id" };
    }

    const idempotencyKey = `admin_refund_${originalEventId}_${Date.now()}`;

    const { data, error } = await supabase.rpc("refund_quota", {
      p_user_id: userId,
      p_original_event_id: originalEventId,
      p_idempotency_key: idempotencyKey,
      p_reason: reason ?? "Admin refund"
    });

    if (error) {
      reply.code(400);
      return { error: error.message };
    }

    return { success: true, refundEventId: data };
  });

  // POST /admin/quota/refresh - Refresh user quota cache
  app.post("/admin/quota/refresh", { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    
    const userId = parseRequiredString(body?.userId);

    if (!userId) {
      reply.code(400);
      return { error: "missing_user_id" };
    }

    const { data, error } = await supabase.rpc("refresh_user_quota_cache", {
      p_user_id: userId
    });

    if (error) {
      reply.code(400);
      return { error: error.message };
    }

    return { success: true };
  });

  // SPA fallback
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/admin/") || request.url.startsWith("/openapi/") || request.url.startsWith("/health")) {
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
