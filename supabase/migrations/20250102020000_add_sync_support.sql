-- Add sync support for managed playlist sync feature

-- 1. Add entry_status to playlists table
-- Tracks the status of the managed playlist entry
ALTER TABLE public.playlists
  ADD COLUMN IF NOT EXISTS entry_status text NOT NULL DEFAULT 'active'
  CONSTRAINT playlists_entry_status_check CHECK (entry_status IN ('active', 'lost', 'auth_invalid'));

COMMENT ON COLUMN public.playlists.entry_status IS 'Status of the managed playlist entry: active (normal), lost (playlist deleted), auth_invalid (authorization revoked)';

-- 2. Add sync_status and removed_at to videos table
-- Tracks whether a video is still in the playlist or has been removed
ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'synced'
  CONSTRAINT videos_sync_status_check CHECK (sync_status IN ('synced', 'removed', 'unavailable'));

ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS removed_at timestamp with time zone;

COMMENT ON COLUMN public.videos.sync_status IS 'Sync status: synced (in playlist), removed (removed from playlist), unavailable (video deleted/private)';
COMMENT ON COLUMN public.videos.removed_at IS 'Timestamp when the video was removed from the playlist';

-- 3. Add skip_reason to video_analyses table
-- Stores reason why analysis was skipped
ALTER TABLE public.video_analyses
  ADD COLUMN IF NOT EXISTS skip_reason text
  CONSTRAINT video_analyses_skip_reason_check CHECK (
    skip_reason IS NULL OR skip_reason IN ('quota_exceeded', 'duration_exceeded', 'video_unavailable')
  );

-- Update status check constraint to include 'skipped' and 'pending' and 'processing'
ALTER TABLE public.video_analyses
  DROP CONSTRAINT IF EXISTS video_analyses_status_check;

-- Note: We need to handle existing data, so we use a more permissive approach
DO $$
BEGIN
  -- Only add constraint if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'video_analyses_status_check_v2'
  ) THEN
    ALTER TABLE public.video_analyses
      ADD CONSTRAINT video_analyses_status_check_v2 CHECK (
        status IN ('pending', 'processing', 'completed', 'failed', 'skipped')
      );
  END IF;
END $$;

COMMENT ON COLUMN public.video_analyses.skip_reason IS 'Reason why analysis was skipped: quota_exceeded, duration_exceeded, video_unavailable';

-- 4. Create user_quotas table
-- Tracks analysis quota usage per user
CREATE TABLE IF NOT EXISTS public.user_quotas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  analysis_count integer NOT NULL DEFAULT 0,
  max_analyses integer NOT NULL DEFAULT 3,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT user_quotas_unique_user UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS user_quotas_user_id_idx ON public.user_quotas (user_id);

ALTER TABLE public.user_quotas ENABLE ROW LEVEL SECURITY;

-- RLS policies for user_quotas
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'user_quotas' AND policyname = 'Users can view their quotas'
  ) THEN
    CREATE POLICY "Users can view their quotas"
      ON public.user_quotas FOR SELECT
      USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'user_quotas' AND policyname = 'Users can insert their quotas'
  ) THEN
    CREATE POLICY "Users can insert their quotas"
      ON public.user_quotas FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'user_quotas' AND policyname = 'Users can update their quotas'
  ) THEN
    CREATE POLICY "Users can update their quotas"
      ON public.user_quotas FOR UPDATE
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

-- Trigger for updated_at
DROP TRIGGER IF EXISTS set_user_quotas_updated_at ON public.user_quotas;
CREATE TRIGGER set_user_quotas_updated_at
  BEFORE UPDATE ON public.user_quotas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.user_quotas IS 'Tracks analysis quota usage per user for free tier limits';

-- 5. Create sync_logs table
-- Records sync job execution history for debugging and monitoring
CREATE TABLE IF NOT EXISTS public.sync_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  playlist_id uuid REFERENCES public.playlists (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'running'
    CONSTRAINT sync_logs_status_check CHECK (status IN ('running', 'completed', 'failed')),
  videos_added integer NOT NULL DEFAULT 0,
  videos_removed integer NOT NULL DEFAULT 0,
  analyses_triggered integer NOT NULL DEFAULT 0,
  analyses_skipped integer NOT NULL DEFAULT 0,
  error text,
  started_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS sync_logs_user_id_idx ON public.sync_logs (user_id);
CREATE INDEX IF NOT EXISTS sync_logs_playlist_id_idx ON public.sync_logs (playlist_id);
CREATE INDEX IF NOT EXISTS sync_logs_started_at_idx ON public.sync_logs (started_at DESC);

ALTER TABLE public.sync_logs ENABLE ROW LEVEL SECURITY;

-- RLS policies for sync_logs - users can view their own logs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'sync_logs' AND policyname = 'Users can view their sync logs'
  ) THEN
    CREATE POLICY "Users can view their sync logs"
      ON public.sync_logs FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- Service role can insert/update sync_logs (for background jobs)
-- Note: Background sync jobs will use service role key

COMMENT ON TABLE public.sync_logs IS 'Records sync job execution history for debugging and monitoring';

-- 6. Create index for efficient sync queries
CREATE INDEX IF NOT EXISTS playlists_entry_status_idx ON public.playlists (entry_status) WHERE entry_status = 'active';
CREATE INDEX IF NOT EXISTS videos_sync_status_idx ON public.videos (sync_status);

