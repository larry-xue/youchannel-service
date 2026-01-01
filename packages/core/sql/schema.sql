create extension if not exists "pgcrypto";

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;

create policy "admin users can read self"
  on public.admin_users
  for select
  using (auth.uid() = user_id);

create policy "service role manages admin users"
  on public.admin_users
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create table if not exists public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'queued',
  kickoff_source text not null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  meta jsonb not null default '{}'::jsonb
);

create table if not exists public.job_runs (
  id uuid primary key default gen_random_uuid(),
  sync_run_id uuid not null references public.sync_runs(id) on delete cascade,
  job_name text not null,
  status text not null default 'queued',
  boss_job_id text,
  attempt integer not null default 1,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  result jsonb
);

create index if not exists sync_runs_created_at_idx on public.sync_runs (created_at desc);
create index if not exists job_runs_sync_run_id_idx on public.job_runs (sync_run_id);
create index if not exists job_runs_created_at_idx on public.job_runs (created_at desc);

alter table public.sync_runs enable row level security;
alter table public.job_runs enable row level security;

create policy "service role manages sync runs"
  on public.sync_runs
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "service role manages job runs"
  on public.job_runs
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
