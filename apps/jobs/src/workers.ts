import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Logger } from "pino";
import { captureException } from "./sentry.js";
import type { Config } from "./config.js";
import {
  getPlaylistWithAccount,
  insertJobRun,
  insertSyncRun,
  reservePlaylistsForSync,
  updateJobRunById,
  updatePlaylistEntryStatus,
  updatePlaylistLastSyncedAt,
  updateSyncRun,
  updateYoutubeAccountTokens,
  type DbPool
} from "./db.js";
import { buildSyncPlaylistJobOptions } from "./queue.js";
import {
  fetchPlaylistItems,
  fetchVideoDetails,
  refreshAccessToken,
  type PlaylistItem,
  OAuthTokenError,
  YouTubeApiError
} from "./youtube.js";

const VIDEO_UPSERT_CHUNK_SIZE = 100;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;

type SyncPlaylistPayload = {
  syncRunId: string;
  playlistId: string;
  userId?: string | null;
  jobRunId: string;
};

type UpsertVideo = {
  youtubeVideoId: string;
  title: string | null;
  description: string | null;
  publishedAt: string | null;
  thumbnailUrl: string | null;
  duration: string | null;
  raw: Record<string, unknown> | null;
};


function pickThumbnailUrl(thumbnails?: Record<string, { url?: string }>) {
  const order = ["maxres", "standard", "high", "medium", "default"];
  for (const key of order) {
    const url = thumbnails?.[key]?.url;
    if (url) return url;
  }
  return null;
}

function normalizeJobList<T>(jobs: JobWithMetadata<T>[] | JobWithMetadata<T>) {
  return Array.isArray(jobs) ? jobs : [jobs];
}

function shouldRefreshAccessToken(accessToken: string | null, expiresAt: string | Date | null) {
  if (!accessToken) return true;
  if (!expiresAt) return false;
  const expiresMs = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  if (Number.isNaN(expiresMs)) return false;
  return expiresMs <= Date.now() + ACCESS_TOKEN_REFRESH_SKEW_MS;
}

async function upsertVideos(
  db: DbPool,
  playlistId: string,
  items: UpsertVideo[],
  seenAt: Date
) {
  const map = new Map<string, string>();

  for (let i = 0; i < items.length; i += VIDEO_UPSERT_CHUNK_SIZE) {
    const chunk = items.slice(i, i + VIDEO_UPSERT_CHUNK_SIZE);
    if (chunk.length === 0) continue;

    const values: Array<string | Date | null | Record<string, unknown>> = [];
    const placeholders = chunk.map((item, index) => {
      const offset = index * 11;
      values.push(
        playlistId,
        item.youtubeVideoId,
        item.title,
        item.description,
        item.publishedAt,
        item.thumbnailUrl,
        item.duration,
        item.raw,
        "synced",
        null,
        seenAt
      );
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11})`;
    });

    const result = await db.query(
      `insert into videos (
         playlist_id,
         youtube_video_id,
         title,
         description,
         published_at,
         thumbnail_url,
         duration,
         raw,
         sync_status,
         removed_at,
         last_seen_at
       ) values ${placeholders.join(", ")}
       on conflict (playlist_id, youtube_video_id)
       do update set
         title = excluded.title,
         description = excluded.description,
         published_at = excluded.published_at,
         thumbnail_url = excluded.thumbnail_url,
         duration = excluded.duration,
         raw = excluded.raw,
         sync_status = 'synced',
         removed_at = null,
         last_seen_at = excluded.last_seen_at
       returning id, youtube_video_id`,
      values
    );

    for (const row of result.rows as Array<{ id: string; youtube_video_id: string }>) {
      map.set(row.youtube_video_id, row.id);
    }
  }

  return map;
}

async function markRemovedVideos(db: DbPool, playlistId: string, videoIds: string[], removedAt: Date) {
  const result = await db.query(
    `update videos
     set sync_status = 'removed',
         removed_at = $2
     where playlist_id = $1
       and sync_status = 'synced'
       and not (youtube_video_id = any($3::text[]))`,
    [playlistId, removedAt, videoIds]
  );

  return result.rowCount ?? 0;
}

async function fetchExistingVideoStatuses(db: DbPool, playlistId: string, videoIds: string[]) {
  if (videoIds.length === 0) return new Map<string, string>();

  const result = await db.query(
    `select youtube_video_id, sync_status
     from videos
     where playlist_id = $1
       and youtube_video_id = any($2::text[])`,
    [playlistId, videoIds]
  );

  const map = new Map<string, string>();
  for (const row of result.rows as Array<{ youtube_video_id: string; sync_status: string }>) {
    map.set(row.youtube_video_id, row.sync_status);
  }
  return map;
}

export async function registerWorkers(params: {
  boss: PgBoss;
  db: DbPool;
  logger: Logger;
  config: Config;
}) {
  const { boss, db, logger, config } = params;

  // Ensure queues exist before registering workers
  await boss.createQueue("kickoff");
  await boss.createQueue("sync.playlist");
  await boss.createQueue("analyze.video");

  await boss.work("kickoff", async (job: any) => {
    const kickoffSource = (job.data as { source?: string } | null)?.source ?? "schedule";
    const requestedBy = (job.data as { requestedBy?: string } | null)?.requestedBy ?? null;

    const syncRun = await insertSyncRun(db, {
      kickoffSource,
      meta: { kickoffJobId: job.id, requestedBy }
    });

    await updateSyncRun(db, syncRun.id, { status: "running", startedAt: new Date() });

    try {
      const playlists = await reservePlaylistsForSync(db, {
        limit: config.kickoffBatchLimit,
        defaultIntervalSec: config.syncIntervalSec
      });

      let enqueued = 0;
      let skipped = 0;

      for (const playlist of playlists) {
        const jobRun = await insertJobRun(db, {
          syncRunId: syncRun.id,
          jobName: "sync.playlist",
          status: "queued",
          playlistId: playlist.id,
          userId: playlist.user_id
        });

        const bossJobId = await boss.send(
          "sync.playlist",
          {
            syncRunId: syncRun.id,
            playlistId: playlist.id,
            userId: playlist.user_id,
            jobRunId: jobRun.id
          },
          buildSyncPlaylistJobOptions(playlist.id)
        );

        if (bossJobId) {
          await updateJobRunById(db, jobRun.id, { bossJobId });
          enqueued += 1;
        } else {
          await updateJobRunById(db, jobRun.id, {
            status: "skipped",
            finishedAt: new Date(),
            error: "deduped",
            result: { reason: "deduped" }
          });
          skipped += 1;
        }
      }

      await updateSyncRun(db, syncRun.id, {
        status: "succeeded",
        finishedAt: new Date(),
        meta: {
          kickoffJobId: job.id,
          requestedBy,
          kickoffSource,
          batchLimit: config.kickoffBatchLimit,
          enqueued,
          skipped
        }
      });

      logger.info({ syncRunId: syncRun.id, enqueued, skipped }, "Kickoff enqueued playlist sync jobs");
      return { syncRunId: syncRun.id, enqueued, skipped };
    } catch (error) {
      await updateSyncRun(db, syncRun.id, {
        status: "failed",
        finishedAt: new Date(),
        meta: {
          kickoffJobId: job.id,
          requestedBy,
          kickoffSource,
          error: error instanceof Error ? error.message : "unknown_error"
        }
      });
      captureException(error);
      logger.error({ syncRunId: syncRun.id, err: error }, "Kickoff failed");
      throw error;
    }
  });

  await boss.work("sync.playlist", { includeMetadata: true }, async (jobs) => {
    const jobList = normalizeJobList(jobs);

    for (const job of jobList) {
      const payload = job.data as SyncPlaylistPayload | null;
      const syncRunId = payload?.syncRunId;
      const playlistId = payload?.playlistId;
      const jobRunId = payload?.jobRunId;

      if (!syncRunId || !playlistId || !jobRunId) {
        throw new Error("sync.playlist missing required payload");
      }

      const attempt = typeof job.retryCount === "number" ? job.retryCount + 1 : 1;
      await updateJobRunById(db, jobRunId, {
        status: "running",
        startedAt: new Date(),
        attempt,
        error: null,
        result: null
      });

      const playlist = await getPlaylistWithAccount(db, playlistId);
      if (!playlist) {
        await updateJobRunById(db, jobRunId, {
          status: "skipped",
          finishedAt: new Date(),
          error: "playlist_missing",
          result: { reason: "playlist_missing" }
        });
        continue;
      }

      if (playlist.entry_status !== "active") {
        await updateJobRunById(db, jobRunId, {
          status: "skipped",
          finishedAt: new Date(),
          error: "playlist_inactive",
          result: { reason: "playlist_inactive" }
        });
        continue;
      }

      let accessToken = playlist.access_token;
      const needsRefresh = shouldRefreshAccessToken(accessToken, playlist.expires_at);

      if (needsRefresh && playlist.refresh_token) {
        const clientId = config.youtubeOAuthClientId;
        const clientSecret = config.youtubeOAuthClientSecret;

        if (!clientId || !clientSecret) {
          await updateJobRunById(db, jobRunId, {
            status: "failed",
            finishedAt: new Date(),
            error: "oauth_config_missing",
            result: { reason: "oauth_config_missing" }
          });
          logger.error({ syncRunId, jobRunId, playlistId }, "Missing OAuth client config for refresh");
          continue;
        }

        try {
          const refreshed = await refreshAccessToken({
            clientId,
            clientSecret,
            refreshToken: playlist.refresh_token
          });

          const tokenUpdates: {
            accessToken: string;
            refreshToken?: string | null;
            expiresAt?: Date | null;
            scope?: string | null;
            tokenType?: string | null;
          } = { accessToken: refreshed.access_token };

          const expiresIn = typeof refreshed.expires_in === "number" ? refreshed.expires_in : Number.NaN;
          if (Number.isFinite(expiresIn)) {
            tokenUpdates.expiresAt = new Date(Date.now() + expiresIn * 1000);
          }

          if (refreshed.refresh_token) {
            tokenUpdates.refreshToken = refreshed.refresh_token;
          }
          if (refreshed.scope !== undefined) {
            tokenUpdates.scope = refreshed.scope ?? null;
          }
          if (refreshed.token_type !== undefined) {
            tokenUpdates.tokenType = refreshed.token_type ?? null;
          }

          if (playlist.youtube_account_id) {
            await updateYoutubeAccountTokens(db, playlist.youtube_account_id, tokenUpdates);
          }

          accessToken = refreshed.access_token;
          logger.info(
            { syncRunId, jobRunId, playlistId, youtubeAccountId: playlist.youtube_account_id },
            "YouTube access token refreshed"
          );
        } catch (error) {
          const finishedAt = new Date();
          if (error instanceof OAuthTokenError) {
            await updateJobRunById(db, jobRunId, {
              status: "failed",
              finishedAt,
              error: "oauth_refresh_failed",
              result: {
                httpStatus: error.status,
                reason: error.error ?? error.message,
                description: error.errorDescription
              }
            });

            if (error.status === 429 || (typeof error.status === "number" && error.status >= 500)) {
              captureException(error);
              logger.error(
                { syncRunId, jobRunId, playlistId, err: error },
                "OAuth refresh retryable error"
              );
              throw error;
            }

            logger.warn(
              { syncRunId, jobRunId, playlistId, err: error },
              "OAuth refresh failed"
            );
            continue;
          }

          await updateJobRunById(db, jobRunId, {
            status: "failed",
            finishedAt,
            error: "oauth_refresh_failed",
            result: { reason: error instanceof Error ? error.message : "unknown_error" }
          });
          captureException(error);
          logger.error({ syncRunId, jobRunId, playlistId, err: error }, "OAuth refresh failed");
          throw error;
        }
      }

      if (!accessToken) {
        await updateJobRunById(db, jobRunId, {
          status: "skipped",
          finishedAt: new Date(),
          error: "auth_missing",
          result: { reason: "auth_missing" }
        });
        continue;
      }

      const startedAt = Date.now();
      try {
        const { items } = await fetchPlaylistItems(accessToken, playlist.playlist_id);
        const idMap = new Map<string, PlaylistItem>();
        const videoIds: string[] = [];

        for (const item of items) {
          const videoId = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
          if (!videoId || idMap.has(videoId)) continue;
          idMap.set(videoId, item);
          videoIds.push(videoId);
        }

        const videoDetails = await fetchVideoDetails(accessToken, videoIds);
        const seenAt = new Date();

        const existingStatuses = await fetchExistingVideoStatuses(db, playlist.id, videoIds);
        const newVideoIds = videoIds.filter((id) => {
          const status = existingStatuses.get(id);
          return !status || status !== "synced";
        });

        const upsertRows: UpsertVideo[] = videoIds.map((videoId) => {
          const item = idMap.get(videoId);
          const snippet = item?.snippet;
          const details = videoDetails.get(videoId);
          return {
            youtubeVideoId: videoId,
            title: snippet?.title ?? null,
            description: snippet?.description ?? null,
            publishedAt: snippet?.publishedAt ?? null,
            thumbnailUrl: pickThumbnailUrl(snippet?.thumbnails),
            duration: details?.contentDetails?.duration ?? null,
            raw: {
              playlistItem: item ?? null,
              video: details ?? null
            }
          };
        });

        await upsertVideos(db, playlist.id, upsertRows, seenAt);
        const removedCount = await markRemovedVideos(db, playlist.id, videoIds, seenAt);
        await updatePlaylistLastSyncedAt(db, playlist.id, seenAt);

        const durationMs = Date.now() - startedAt;
        const result = {
          fetchedCount: videoIds.length,
          newCount: newVideoIds.length,
          removedCount,
          durationMs,
          etagHit: false,
          analysesEnqueued: 0,
          analysesSkipped: 0,
          analysisSkipReasons: {}
        };

        await updateJobRunById(db, jobRunId, {
          status: "succeeded",
          finishedAt: new Date(),
          result
        });
        logger.info(
          { syncRunId, jobRunId, playlistId, result },
          "Playlist sync completed"
        );
      } catch (error) {
        if (error instanceof YouTubeApiError) {
          if (error.status === 404) {
            await updatePlaylistEntryStatus(db, playlist.id, "lost");
            await updateJobRunById(db, jobRunId, {
              status: "skipped",
              finishedAt: new Date(),
              error: "playlist_missing",
              result: { httpStatus: error.status, reason: error.reason }
            });
            continue;
          }

          if (error.status === 401 || error.status === 403) {
            await updatePlaylistEntryStatus(db, playlist.id, "auth_invalid");
            await updateJobRunById(db, jobRunId, {
              status: "skipped",
              finishedAt: new Date(),
              error: "auth_invalid",
              result: { httpStatus: error.status, reason: error.reason }
            });
            continue;
          }

          if (error.status === 429 || error.status >= 500) {
            await updateJobRunById(db, jobRunId, {
              status: "failed",
              finishedAt: new Date(),
              error: error.message,
              result: { httpStatus: error.status, reason: error.reason }
            });
            captureException(error);
            logger.error({ syncRunId, jobRunId, playlistId, err: error }, "Playlist sync retryable error");
            throw error;
          }

          await updateJobRunById(db, jobRunId, {
            status: "failed",
            finishedAt: new Date(),
            error: error.message,
            result: { httpStatus: error.status, reason: error.reason }
          });
          continue;
        }

        await updateJobRunById(db, jobRunId, {
          status: "failed",
          finishedAt: new Date(),
          error: error instanceof Error ? error.message : "unknown error"
        });
        captureException(error);
        logger.error({ syncRunId, jobRunId, playlistId, err: error }, "Playlist sync failed");
        throw error;
      }
    }
  });
}
