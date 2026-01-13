import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import {
  parseLimit,
  parseOffset,
  parseOptionalQueryString,
  parseTimestamp
} from "@jobs/server/utils";

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

type Deps = {
  supabase: SupabaseClient;
  requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void> | void;
};

export function registerAdminSystemUserRoutes(app: FastifyInstance, deps: Deps) {
  app.get("/admin/system-users", { preHandler: deps.requireAdmin }, async (request, reply) => {
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

    const [users, youtubeAccounts, quotasResult, adminUsersResult] = await Promise.all([
      listAllAuthUsers(deps.supabase),
      listAllYoutubeAccounts(deps.supabase),
      deps.supabase
        .from("user_quotas")
        .select(
          "user_id, video_seconds_total, video_seconds_remaining, chat_seconds_total, chat_seconds_remaining, max_video_seconds, period_start_at, period_end_at"
        ),
      deps.supabase.from("admin_users").select("user_id")
    ]);

    if (quotasResult.error) {
      throw quotasResult.error;
    }

    if (adminUsersResult.error) {
      throw adminUsersResult.error;
    }

    const adminUserIds = new Set(adminUsersResult.data.map((u) => u.user_id));


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

    let filteredUsers = users.filter((user) => !adminUserIds.has(user.id));

    if (email) {
      const lowerEmail = email.toLowerCase();
      filteredUsers = filteredUsers.filter(
        (user) => user.email?.toLowerCase().includes(lowerEmail)
      );
    }

    filteredUsers.sort((a, b) => parseTimestamp(b.created_at) - parseTimestamp(a.created_at));

    const total = filteredUsers.length;
    const effectiveLimit = limit ?? 20;
    const effectiveOffset = offset ?? 0;

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

  app.delete("/admin/system-users/:userId", { preHandler: deps.requireAdmin }, async (request, reply) => {
    const { userId } = request.params as { userId: string };

    // 1. Check if the user is an admin
    const { data: adminUser, error: adminCheckError } = await deps.supabase
      .from("admin_users")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (adminCheckError) {
      throw adminCheckError;
    }

    if (adminUser) {
      reply.code(403);
      return { error: "Cannot delete an admin user" };
    }

    // 2. Delete the user from Supabase Auth (cascades to related tables)
    const { error: deleteError } = await deps.supabase.auth.admin.deleteUser(userId);

    if (deleteError) {
      throw deleteError;
    }

    return { success: true };
  });
}
