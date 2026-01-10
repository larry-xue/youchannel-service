-- Simplify video_analyses: Remove dual state management
-- Trust pg-boss for job scheduling, timeouts, and retries

-- Step 1: Migrate existing queued/processing records to pending
UPDATE public.video_analyses
SET status = 'pending'
WHERE status IN ('queued', 'processing');

-- Step 2: Drop recovery-related columns
ALTER TABLE public.video_analyses
  DROP COLUMN IF EXISTS claimed_at,
  DROP COLUMN IF EXISTS claimed_by,
  DROP COLUMN IF EXISTS failed_count;

-- Step 3: Drop recovery index
DROP INDEX IF EXISTS idx_video_analyses_recovery;

-- Step 4: Update status constraint
-- Remove old constraints first
ALTER TABLE public.video_analyses
  DROP CONSTRAINT IF EXISTS video_analyses_status_check_v3;

ALTER TABLE public.video_analyses
  DROP CONSTRAINT IF EXISTS video_analyses_status_check_v2;

ALTER TABLE public.video_analyses
  DROP CONSTRAINT IF EXISTS video_analyses_status_check;

-- Add new constraint with simplified statuses
ALTER TABLE public.video_analyses
  ADD CONSTRAINT video_analyses_status_check_v4 CHECK (
    status IN ('pending', 'completed', 'failed', 'skipped')
  );

-- Add index for pending status queries (optional, for API polling)
CREATE INDEX IF NOT EXISTS idx_video_analyses_pending
  ON public.video_analyses (status, updated_at)
  WHERE status = 'pending';
