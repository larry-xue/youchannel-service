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

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
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
