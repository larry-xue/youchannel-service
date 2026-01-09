import { Pool } from "pg";

export type DbPool = Pool;

export type AdminVideoRow = {
  id: string;
  user_id: string;
  youtube_video_id: string;
  title: string | null;
  duration: string | null;
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

export function createDbPool(databaseUrl: string) {
  return new Pool({ connectionString: databaseUrl });
}

export async function listAdminVideos(
  pool: DbPool,
  params: {
    userId?: string;
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
    conditions.push(`v.user_id = $${values.length}`);
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
            v.user_id,
            v.youtube_video_id,
            v.title,
            v.duration,
            v.removed_at,
            v.created_at,
            coalesce(ac.analysis_count, 0) as analysis_count,
            la.id as analysis_id,
            la.status as analysis_status,
            la.model as analysis_model,
            la.analysis_text as analysis_text,
            la.error as analysis_error,
            la.created_at as analysis_created_at,
            la.updated_at as analysis_updated_at
     from videos v
     left join lateral (
       select count(*)::int as analysis_count
       from video_analyses
       where video_id = v.id
     ) ac on true
     left join lateral (
       select id,
       status,
       model,
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
