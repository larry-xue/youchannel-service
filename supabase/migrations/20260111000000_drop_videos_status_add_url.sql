-- Drop unused videos status field and add url column

ALTER TABLE public.videos
  DROP CONSTRAINT IF EXISTS videos_status_check;

DROP INDEX IF EXISTS videos_status_idx;

ALTER TABLE public.videos
  DROP COLUMN IF EXISTS status;

ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS url text;

COMMENT ON COLUMN public.videos.url IS 'Canonical video URL.';
