-- Add admin users and job tracking tables
-- These tables are used by the admin panel and jobs service

-- 1. Admin users table
CREATE TABLE IF NOT EXISTS public.admin_users (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin users can read self"
  ON public.admin_users
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "service role manages admin users"
  ON public.admin_users
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 2. Sync runs table
-- Tracks sync job execution runs
CREATE TABLE IF NOT EXISTS public.sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'queued',
  kickoff_source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS sync_runs_created_at_idx ON public.sync_runs (created_at DESC);

ALTER TABLE public.sync_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role manages sync runs"
  ON public.sync_runs
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 3. Job runs table
-- Tracks individual job executions within a sync run
CREATE TABLE IF NOT EXISTS public.job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id uuid NOT NULL REFERENCES public.sync_runs(id) ON DELETE CASCADE,
  job_name text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  boss_job_id text,
  attempt integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  result jsonb
);

CREATE INDEX IF NOT EXISTS job_runs_sync_run_id_idx ON public.job_runs (sync_run_id);
CREATE INDEX IF NOT EXISTS job_runs_created_at_idx ON public.job_runs (created_at DESC);

ALTER TABLE public.job_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role manages job runs"
  ON public.job_runs
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
