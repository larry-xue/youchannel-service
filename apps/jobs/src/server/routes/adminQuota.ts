import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseLimit, parseOptionalString, parseRequiredString } from "@jobs/server/utils.js";

type Deps = {
  supabase: SupabaseClient;
  requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void> | void;
};

export function registerAdminQuotaRoutes(app: FastifyInstance, deps: Deps) {
  app.get("/admin/quota/:userId", { preHandler: deps.requireAdmin }, async (request, reply) => {
    const { userId } = request.params as { userId: string };

    const { data: quotaCache, error: quotaCacheError } = await deps.supabase
      .from("user_quotas")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (quotaCacheError) {
      throw quotaCacheError;
    }

    const { data: grants, error: grantsError } = await deps.supabase
      .from("quota_grants")
      .select("*")
      .eq("user_id", userId)
      .order("consume_priority", { ascending: true })
      .order("valid_to", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });

    if (grantsError) {
      throw grantsError;
    }

    const { data: events, error: eventsError } = await deps.supabase
      .from("quota_usage_events")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (eventsError) {
      throw eventsError;
    }

    const { data: userData, error: userError } = await deps.supabase.auth.admin.getUserById(userId);

    return {
      user: userError
        ? null
        : {
            id: userData.user.id,
            email: userData.user.email ?? null
          },
      quotaCache: quotaCache ?? null,
      grants: grants ?? [],
      events: events ?? []
    };
  });

  app.post("/admin/quota/grants", { preHandler: deps.requireAdmin }, async (request, reply) => {
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

    const { data, error } = await deps.supabase
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

  app.post("/admin/quota/refund", { preHandler: deps.requireAdmin }, async (request, reply) => {
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

    const { data, error } = await deps.supabase.rpc("refund_quota", {
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

  app.post("/admin/quota/refresh", { preHandler: deps.requireAdmin }, async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;

    const userId = parseRequiredString(body?.userId);

    if (!userId) {
      reply.code(400);
      return { error: "missing_user_id" };
    }

    const { data, error } = await deps.supabase.rpc("refresh_user_quota", {
      p_user_id: userId
    });

    if (error) {
      reply.code(400);
      return { error: error.message };
    }

    return { success: true };
  });
}
