-- Allow multiple analyses per video (support re-analysis)
-- Drop unique constraint to allow multiple analysis records per video
ALTER TABLE public.video_analyses
  DROP CONSTRAINT IF EXISTS video_analyses_unique_video;

-- Ensure index for efficient lookups by video_id
CREATE INDEX IF NOT EXISTS idx_video_analyses_video_id
  ON public.video_analyses (video_id, created_at DESC);
