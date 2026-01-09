-- Add claim tracking fields for job recovery
-- These fields help detect and recover orphaned/stale processing jobs

ALTER TABLE public.video_analyses
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_by text;

COMMENT ON COLUMN public.video_analyses.claimed_at IS 'Timestamp when a worker claimed this job for processing';
COMMENT ON COLUMN public.video_analyses.claimed_by IS 'Identifier of the worker instance that claimed this job';

-- Create index for efficient recovery queries
CREATE INDEX IF NOT EXISTS idx_video_analyses_recovery 
  ON public.video_analyses (status, claimed_at) 
  WHERE status IN ('queued', 'processing', 'failed');
