// 如果设置了 VITE_JOBS_API_URL，使用它；否则使用相对路径（前后端同域）
const baseUrl = (import.meta.env.VITE_JOBS_API_URL as string | undefined) || "";

async function request<T>(path: string, token: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options?.headers ?? {})
    }
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || response.statusText);
  }

  return (await response.json()) as T;
}

export type YoutubeAccountSummary = {
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

export type UserQuotaInfo = {
  video_seconds_total: number;
  video_seconds_remaining: number;
  chat_seconds_total: number;
  chat_seconds_remaining: number;
  max_video_seconds: number;
  period_start_at: string | null;
  period_end_at: string | null;
} | null;

export type SystemUserRow = {
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

export type SystemUsersParams = {
  email?: string;
  limit?: number;
  offset?: number;
};

export type AdminUserIdentity = {
  id: number;
  provider: string | null;
  identity_data: Record<string, unknown> | null;
  user_id: string;
};

export type AdminUserRow = {
  user_id: string;
  created_at: string;
  user_created_at: string | null;
  email: string | null;
  last_sign_in_at: string | null;
  confirmed_at: string | null;
  email_confirmed_at: string | null;
  phone: string | null;
  phone_confirmed_at: string | null;
  role: string | null;
  aud: string | null;
  app_metadata: Record<string, unknown> | null;
  user_metadata: Record<string, unknown> | null;
  identities: AdminUserIdentity[];
};

export type AdminVideoRow = {
  id: string;
  user_id: string;
  youtube_video_id: string;
  title: string | null;
  duration: string | null;
  status: string;
  removed_at: string | null;
  created_at: string;
  analysis_count: number;
  analysis_id: string | null;
  analysis_status: string | null;
  analysis_model: string | null;
  analysis_text: string | null;
  analysis_error: string | null;
  analysis_created_at: string | null;
  analysis_updated_at: string | null;
};

export type AdminVideosParams = {
  userId?: string;
  youtubeVideoId?: string;
  title?: string;
  status?: string;
  analysisStatus?: string;
  limit?: number;
  offset?: number;
};

export function fetchAdminVideos(
  token: string,
  params?: { userId?: string; status?: string; limit?: number; offset?: number }
) {
  const searchParams = new URLSearchParams();
  if (params?.userId) searchParams.set("userId", params.userId);
  if (params?.status) searchParams.set("status", params.status);
  if (params?.limit) searchParams.set("limit", String(params.limit));
  if (params?.offset) searchParams.set("offset", String(params.offset));
  const suffix = searchParams.toString();
  const path = suffix ? `/admin/videos?${suffix}` : "/admin/videos";
  return request<{ rows: AdminVideoRow[] }>(path, token);
}

export function enqueueAnalysis(
  token: string,
  payload: { userId: string; videoIds?: string[]; limit?: number; prompt?: string }
) {
  return request<{
    userId: string;
    candidateCount: number;
    enqueued: number;
    skipped: number;
    skipReasons: Record<string, number>;
  }>("/admin/analysis", token, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function fetchAdminUsers(token: string) {
  return request<{ rows: AdminUserRow[] }>("/admin/users", token);
}

export function addAdminUser(
  token: string,
  email: string,
  options?: { password?: string; createIfNotExists?: boolean }
) {
  return request<{ success: boolean; data?: unknown; error?: string }>(
    "/admin/users",
    token,
    {
      method: "POST",
      body: JSON.stringify({
        email,
        password: options?.password,
        createIfNotExists: options?.createIfNotExists
      })
    }
  );
}

export function removeAdminUser(token: string, userId: string) {
  return request<{ success: boolean; error?: string }>(
    `/admin/users/${userId}`,
    token,
    {
      method: "DELETE"
    }
  );
}

export function fetchSystemUsers(token: string, params?: SystemUsersParams) {
  const searchParams = new URLSearchParams();
  if (params?.email) searchParams.set("email", params.email);
  if (params?.limit) searchParams.set("limit", String(params.limit));
  if (params?.offset) searchParams.set("offset", String(params.offset));
  const suffix = searchParams.toString();
  const path = suffix ? `/admin/system-users?${suffix}` : "/admin/system-users";
  return request<{ rows: SystemUserRow[]; total: number }>(path, token);
}

// Quota admin types
export type QuotaGrant = {
  id: string;
  user_id: string;
  source_type: string;
  source_ref: string | null;
  video_seconds_total: number;
  video_seconds_remaining: number;
  chat_seconds_total: number;
  chat_seconds_remaining: number;
  max_video_seconds: number;
  valid_from: string;
  valid_to: string | null;
  consume_priority: number;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
  user_email?: string;
  user_role?: string;
};

export type QuotaUsageEvent = {
  id: string;
  user_id: string;
  user_email?: string;
  event_type: string;
  reason: string | null;
  reference_type: string | null;
  reference_id: string | null;
  video_seconds_delta: number;
  chat_seconds_delta: number;
  video_duration_seconds: number | null;
  context: Record<string, unknown> | null;
  idempotency_key: string;
  created_at: string;
  quota_before: number | null;
  quota_after: number | null;
};

export type QuotaInfo = {
  grants: QuotaGrant[];
  events: QuotaUsageEvent[];
};

export type QuotaCache = {
  user_id: string;
  video_seconds_total: number;
  video_seconds_remaining: number;
  chat_seconds_total: number;
  chat_seconds_remaining: number;
  max_video_seconds: number;
  period_start_at: string;
  period_end_at: string | null;
  created_at: string;
  updated_at: string;
};

export type UserQuotaDetails = {
  user: { id: string; email: string | null } | null;
  quotaCache: QuotaCache | null;
  grants: QuotaGrant[];
  events: QuotaUsageEvent[];
};

export type AddGrantParams = {
  userId: string;
  videoSecondsTotal: number;
  chatSecondsTotal: number;
  maxVideoSeconds: number;
  sourceType?: string;
  sourceRef?: string;
  validTo?: string;
  consumePriority?: number;
};

export type RefundParams = {
  userId: string;
  originalEventId: string;
  reason?: string;
};

// Quota admin API functions
export function fetchUserQuota(token: string, userId: string) {
  return request<UserQuotaDetails>(`/admin/quota/${userId}`, token);
}

export function addQuotaGrant(token: string, params: AddGrantParams) {
  return request<{ success: boolean; grant?: QuotaGrant; error?: string }>(
    "/admin/quota/grants",
    token,
    {
      method: "POST",
      body: JSON.stringify(params)
    }
  );
}

export function refundQuota(token: string, params: RefundParams) {
  return request<{ success: boolean; refundEventId?: string; error?: string }>(
    "/admin/quota/refund",
    token,
    {
      method: "POST",
      body: JSON.stringify(params)
    }
  );
}

export function refreshQuotaCache(token: string, userId: string) {
  return request<{ success: boolean; error?: string }>(
    "/admin/quota/refresh",
    token,
    {
      method: "POST",
      body: JSON.stringify({ userId })
    }
  );
}

export function fetchQuotaInfo(token: string) {
  return request<QuotaInfo>("/admin/quota", token);
}

