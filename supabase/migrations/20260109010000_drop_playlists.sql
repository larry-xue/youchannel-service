-- Drop playlists table and related playlist_id columns

-- job_runs: remove playlist_id column/index if present
ALTER TABLE public.job_runs
  DROP COLUMN IF EXISTS playlist_id;

DROP INDEX IF EXISTS job_runs_playlist_id_idx;

-- playlists: drop table (cascades remaining policies/indexes/constraints)
DROP TABLE IF EXISTS public.playlists CASCADE;
