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

export type SystemUserRow = {
  id: string;
  email: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  youtube_accounts: YoutubeAccountSummary[];
};

export function fetchSyncRuns(token: string, limit = 50) {
  return request<{ rows: Array<Record<string, unknown>> }>(`/admin/sync-runs?limit=${limit}`, token);
}

export function fetchJobRuns(token: string, syncRunId: string, limit = 50) {
  const searchParams = new URLSearchParams();
  if (limit) {
    searchParams.set("limit", String(limit));
  }
  const suffix = searchParams.toString();
  const path = suffix
    ? `/admin/sync-runs/${syncRunId}/job-runs?${suffix}`
    : `/admin/sync-runs/${syncRunId}/job-runs`;
  return request<{ rows: Array<Record<string, unknown>> }>(path, token);
}

export function retryJobRun(token: string, jobRunId: string) {
  return request<{ bossJobId: string | null }>(
    `/admin/job-runs/${jobRunId}/retry`,
    token,
    { method: "POST" }
  );
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
  return request<{ rows: Array<{ user_id: string; email?: string; created_at: string; user_created_at?: string }> }>(
    "/admin/users",
    token
  );
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

export function fetchSystemUsers(token: string) {
  return request<{ rows: SystemUserRow[] }>("/admin/system-users", token);
}
