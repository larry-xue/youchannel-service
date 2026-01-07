import { Pool } from "pg";

export type DbPool = Pool;

export type PlaylistAnalysisTarget = {
  id: string;
  user_id: string;
  entry_status: string;
  analysis_prompt: string;
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

export function createDbPool(databaseUrl: string) {
  return new Pool({ connectionString: databaseUrl });
}

export async function getPlaylistForAnalysis(pool: DbPool, playlistId: string) {
  const result = await pool.query<PlaylistAnalysisTarget>(
    `select id, user_id, entry_status, analysis_prompt
     from playlists
     where id = $1`,
    [playlistId]
  );

  return result.rows[0] ?? null;
}

export async function listAdminVideos(
  pool: DbPool,
  params: {
    userId?: string;
    playlistId?: string;
    syncStatus?: string;
    analysisStatus?: string;
    youtubeVideoId?: string;
    title?: string;
    limit?: number;
    offset?: number;
  }
) {
  const values: Array<string | number> = [];
  const conditions: string[] = [];

  if (params.userId) {
    values.push(params.userId);
    conditions.push(`p.user_id = $${values.length}`);
  }

  if (params.playlistId) {
    values.push(params.playlistId);
    conditions.push(`v.playlist_id = $${values.length}`);
  }

  if (params.syncStatus) {
    values.push(params.syncStatus);
    conditions.push(`v.sync_status = $${values.length}`);
  }

  if (params.analysisStatus) {
    if (params.analysisStatus === "none") {
      conditions.push(`la.status is null`);
    } else {
      values.push(params.analysisStatus);
      conditions.push(`la.status = $${values.length}`);
    }
  }

  if (params.youtubeVideoId) {
    values.push(params.youtubeVideoId);
    conditions.push(`v.youtube_video_id = $${values.length}`);
  }

  if (params.title) {
    values.push(`%${params.title}%`);
    conditions.push(`v.title ilike $${values.length}`);
  }

  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  values.push(limit);
  const limitIndex = values.length;
  values.push(offset);
  const offsetIndex = values.length;

  const whereClause = conditions.length ? `where ${conditions.join(" and ")}` : "";

  const result = await pool.query<AdminVideoRow>(
    `select v.id,
            v.playlist_id,
            p.user_id as playlist_user_id,
            p.playlist_id as playlist_youtube_id,
            v.youtube_video_id,
            v.title,
            v.duration,
            v.sync_status,
            v.last_seen_at,
            v.removed_at,
            v.created_at,
            coalesce(ac.analysis_count, 0) as analysis_count,
            la.id as analysis_id,
            la.status as analysis_status,
            la.model as analysis_model,
            la.prompt as analysis_prompt,
            la.prompt_hash as analysis_prompt_hash,
            la.analysis_text as analysis_text,
            la.error as analysis_error,
            la.created_at as analysis_created_at,
            la.updated_at as analysis_updated_at
     from videos v
     join playlists p on p.id = v.playlist_id
     left join lateral (
       select count(*)::int as analysis_count
       from video_analyses
       where video_id = v.id
     ) ac on true
     left join lateral (
       select id,
              status,
              model,
              prompt,
              prompt_hash,
              analysis_text,
              error,
              created_at,
              updated_at
       from video_analyses
       where video_id = v.id
       order by created_at desc
       limit 1
     ) la on true
     ${whereClause}
     order by v.created_at desc
     limit $${limitIndex}
     offset $${offsetIndex}`,
    values
  );

  return result.rows;
}
