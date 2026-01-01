-- Add jobs queue and playlist scheduling support

-- 1. Add next_sync_at to playlists
ALTER TABLE public.playlists
  ADD COLUMN IF NOT EXISTS next_sync_at timestamp with time zone;

ALTER TABLE public.playlists
  ALTER COLUMN next_sync_at SET DEFAULT timezone('utc'::text, now());

UPDATE public.playlists
  SET next_sync_at = timezone('utc'::text, now())
  WHERE next_sync_at IS NULL;

CREATE INDEX IF NOT EXISTS playlists_next_sync_at_idx
  ON public.playlists (next_sync_at);

-- 2. Create jobs table
CREATE TABLE IF NOT EXISTS public.jobs (
  id bigserial PRIMARY KEY,
  type text NOT NULL,
  user_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued'
    CONSTRAINT jobs_status_check CHECK (status IN ('queued', 'running', 'succeeded', 'dead')),
  priority integer NOT NULL DEFAULT 0,
  run_after timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8,
  last_error text,
  last_error_at timestamp with time zone,
  locked_by text,
  locked_at timestamp with time zone,
  lease_until timestamp with time zone,
  dedupe_key text,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedupe_key_uniq
  ON public.jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS jobs_pick_idx
  ON public.jobs (status, run_after, priority DESC, id);

CREATE INDEX IF NOT EXISTS jobs_lease_until_idx
  ON public.jobs (lease_until);

DROP TRIGGER IF EXISTS set_jobs_updated_at ON public.jobs;
CREATE TRIGGER set_jobs_updated_at
  BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3. RPC to claim a job with SKIP LOCKED
CREATE OR REPLACE FUNCTION public.claim_job(
  p_lock_id text,
  p_job_types text[] DEFAULT NULL,
  p_lease_seconds integer DEFAULT 300
)
RETURNS SETOF public.jobs
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := timezone('utc'::text, now());
BEGIN
  RETURN QUERY
  UPDATE public.jobs
  SET status = 'running',
      locked_by = p_lock_id,
      locked_at = v_now,
      lease_until = v_now + make_interval(secs => p_lease_seconds),
      attempts = attempts + 1,
      updated_at = v_now
  WHERE id = (
    SELECT id
    FROM public.jobs
    WHERE run_after <= v_now
      AND attempts < max_attempts
      AND (
        status = 'queued'
        OR (status = 'running' AND lease_until <= v_now)
      )
      AND (p_job_types IS NULL OR type = ANY(p_job_types))
    ORDER BY priority DESC, id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
END;
$$;
