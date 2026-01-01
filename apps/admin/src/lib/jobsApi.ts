const baseUrl = import.meta.env.VITE_JOBS_API_URL as string | undefined;

if (!baseUrl) {
  throw new Error("Missing VITE_JOBS_API_URL");
}

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

export function kickoff(token: string) {
  return request<{ bossJobId: string }>("/admin/kickoff", token, { method: "POST" });
}

export function fetchSyncRuns(token: string, limit = 50) {
  return request<{ rows: Array<Record<string, unknown>> }>(`/admin/sync-runs?limit=${limit}`, token);
}

export function fetchJobRuns(token: string, params?: { syncRunId?: string; limit?: number }) {
  const searchParams = new URLSearchParams();
  if (params?.syncRunId) {
    searchParams.set("syncRunId", params.syncRunId);
  }
  if (params?.limit) {
    searchParams.set("limit", String(params.limit));
  }

  const suffix = searchParams.toString();
  const path = suffix ? `/admin/job-runs?${suffix}` : "/admin/job-runs";
  return request<{ rows: Array<Record<string, unknown>> }>(path, token);
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