-- Add queued analysis status support and failure tracking

ALTER TABLE public.video_analyses
  ADD COLUMN IF NOT EXISTS failed_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.video_analyses.failed_count IS 'Number of failed analysis attempts since last success.';

ALTER TABLE public.video_analyses
  DROP CONSTRAINT IF EXISTS video_analyses_status_check_v3;

ALTER TABLE public.video_analyses
  DROP CONSTRAINT IF EXISTS video_analyses_status_check_v2;

ALTER TABLE public.video_analyses
  DROP CONSTRAINT IF EXISTS video_analyses_status_check;

ALTER TABLE public.video_analyses
  ADD CONSTRAINT video_analyses_status_check_v3 CHECK (
    status IN ('queued', 'pending', 'processing', 'completed', 'failed', 'skipped')
  );
