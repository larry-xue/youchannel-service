export type PlaylistItem = {
  snippet?: {
    title?: string;
    description?: string;
    publishedAt?: string;
    thumbnails?: Record<string, { url?: string }>;
    resourceId?: {
      videoId?: string;
    };
  };
  contentDetails?: {
    videoId?: string;
  };
};

export type VideoItem = {
  id: string;
  contentDetails?: {
    duration?: string;
  };
};

type PlaylistItemsResponse = {
  etag?: string;
  items?: PlaylistItem[];
  nextPageToken?: string;
};

type VideoDetailsResponse = {
  items?: VideoItem[];
};

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

export class YouTubeApiError extends Error {
  status: number;
  reason?: string;

  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

export class OAuthTokenError extends Error {
  status?: number;
  error?: string;
  errorDescription?: string;

  constructor(
    message: string,
    params: { status?: number; error?: string; errorDescription?: string } = {}
  ) {
    super(message);
    this.status = params.status;
    this.error = params.error;
    this.errorDescription = params.errorDescription;
  }
}

async function requestJson<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    let message = response.statusText;
    let reason: string | undefined;
    try {
      const body = (await response.json()) as {
        error?: { message?: string; errors?: Array<{ reason?: string }> };
      };
      message = body?.error?.message ?? message;
      reason = body?.error?.errors?.[0]?.reason;
    } catch {
      // ignore JSON parse errors
    }
    throw new YouTubeApiError(response.status, message, reason);
  }

  return (await response.json()) as T;
}

type OAuthRefreshResponse = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export async function refreshAccessToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}) {
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    refresh_token: params.refreshToken,
    grant_type: "refresh_token"
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });

  if (!response.ok) {
    let errorCode: string | undefined;
    let errorDescription: string | undefined;
    let message = response.statusText || "OAuth refresh failed";

    try {
      const payload = (await response.json()) as {
        error?: string;
        error_description?: string;
      };
      errorCode = payload.error;
      errorDescription = payload.error_description;
      if (errorDescription || errorCode) {
        message = errorDescription ?? errorCode ?? message;
      }
    } catch {
      // ignore JSON parse errors
    }

    throw new OAuthTokenError(message, {
      status: response.status,
      error: errorCode,
      errorDescription
    });
  }

  const data = (await response.json()) as OAuthRefreshResponse;
  if (!data?.access_token) {
    throw new OAuthTokenError("OAuth refresh response missing access_token");
  }

  return data;
}

export async function fetchPlaylistItems(accessToken: string, playlistId: string) {
  const items: PlaylistItem[] = [];
  let pageToken: string | undefined;
  let etag: string | undefined;

  do {
    const url = new URL(`${YOUTUBE_API_BASE}/playlistItems`);
    url.searchParams.set("part", "snippet,contentDetails");
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("playlistId", playlistId);
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const data = await requestJson<PlaylistItemsResponse>(url.toString(), accessToken);
    if (!etag && data.etag) {
      etag = data.etag;
    }
    items.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return { items, etag };
}

export async function fetchVideoDetails(accessToken: string, videoIds: string[]) {
  const results = new Map<string, VideoItem>();
  if (videoIds.length === 0) {
    return results;
  }

  for (const batch of chunk(videoIds, 50)) {
    const url = new URL(`${YOUTUBE_API_BASE}/videos`);
    url.searchParams.set("part", "contentDetails");
    url.searchParams.set("id", batch.join(","));

    const data = await requestJson<VideoDetailsResponse>(url.toString(), accessToken);
    for (const item of data.items ?? []) {
      results.set(item.id, item);
    }
  }

  return results;
}
