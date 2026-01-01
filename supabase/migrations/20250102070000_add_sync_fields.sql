-- Add sync scheduling and tracking fields

-- 1. Track when a video was last observed in a playlist
ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

-- 2. Allow per-playlist sync interval overrides
ALTER TABLE public.playlists
  ADD COLUMN IF NOT EXISTS sync_interval_sec integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'playlists_sync_interval_sec_check'
  ) THEN
    ALTER TABLE public.playlists
      ADD CONSTRAINT playlists_sync_interval_sec_check
      CHECK (sync_interval_sec IS NULL OR sync_interval_sec > 0);
  END IF;
END $$;

-- 3. Store playlist and user context for job runs
ALTER TABLE public.job_runs
  ADD COLUMN IF NOT EXISTS playlist_id uuid REFERENCES public.playlists (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS job_runs_playlist_id_idx ON public.job_runs (playlist_id);
CREATE INDEX IF NOT EXISTS job_runs_user_id_idx ON public.job_runs (user_id);
