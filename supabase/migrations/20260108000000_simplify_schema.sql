-- Simplify videos and video_analyses schema

-- 1. video_analyses: remove prompt and prompt_hash, enforce unique video_id
-- We need to handle duplicates first. For now, we'll keep the most recent analysis for each video.
-- We can do this by deleting older analyses for the same video.

-- Create a temporary table to identify analyses to keep (latest per video)
CREATE TEMP TABLE latest_analyses AS
SELECT DISTINCT ON (video_id) id
FROM public.video_analyses
ORDER BY video_id, created_at DESC;

-- Delete analyses that are not in the top 1 per video
DELETE FROM public.video_analyses
WHERE id NOT IN (SELECT id FROM latest_analyses);

-- Now we can drop the columns and add the new constraint
ALTER TABLE public.video_analyses
  DROP CONSTRAINT IF EXISTS video_analyses_unique_prompt;

ALTER TABLE public.video_analyses
  DROP COLUMN IF EXISTS prompt,
  DROP COLUMN IF EXISTS prompt_hash;

ALTER TABLE public.video_analyses
  ADD CONSTRAINT video_analyses_unique_video UNIQUE (video_id);

-- 2. videos: remove last_seen_at and sync_status, add status
ALTER TABLE public.videos
  DROP COLUMN IF EXISTS last_seen_at,
  DROP COLUMN IF EXISTS sync_status;

ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';

-- Add check constraint for status
ALTER TABLE public.videos
  ADD CONSTRAINT videos_status_check 
  CHECK (status IN ('pending', 'active', 'error'));

-- Create index for status
CREATE INDEX IF NOT EXISTS videos_status_idx ON public.videos (status);

-- Clean up any indices that might depend on dropped columns
DROP INDEX IF EXISTS videos_sync_status_idx;
