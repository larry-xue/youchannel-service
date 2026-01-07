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
  analysis_count: number;
  max_analyses: number;
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
  playlist_id: string;
  playlist_user_id: string;
  playlist_youtube_id: string;
  youtube_video_id: string;
  title: string | null;
  duration: string | null;
  sync_status: string;
  last_seen_at: string | null;
  removed_at: string | null;
  created_at: string;
  analysis_count: number;
  analysis_id: string | null;
  analysis_status: string | null;
  analysis_model: string | null;
  analysis_prompt: string | null;
  analysis_prompt_hash: string | null;
  analysis_text: string | null;
  analysis_error: string | null;
  analysis_created_at: string | null;
  analysis_updated_at: string | null;
};

export type AdminVideosParams = {
  userId?: string;
  playlistId?: string;
  youtubeVideoId?: string;
  title?: string;
  syncStatus?: string;
  analysisStatus?: string;
  limit?: number;
  offset?: number;
};

export function fetchAdminVideos(
  token: string,
  params?: { userId?: string; syncStatus?: string; limit?: number; offset?: number }
) {
  const searchParams = new URLSearchParams();
  if (params?.userId) searchParams.set("userId", params.userId);
  if (params?.syncStatus) searchParams.set("syncStatus", params.syncStatus);
  if (params?.limit) searchParams.set("limit", String(params.limit));
  if (params?.offset) searchParams.set("offset", String(params.offset));
  const suffix = searchParams.toString();
  const path = suffix ? `/admin/videos?${suffix}` : "/admin/videos";
  return request<{ rows: AdminVideoRow[] }>(path, token);
}

export function enqueueAnalysis(
  token: string,
  payload: { playlistId: string; userId?: string; videoIds?: string[]; limit?: number }
) {
  return request<{
    playlistId: string;
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
