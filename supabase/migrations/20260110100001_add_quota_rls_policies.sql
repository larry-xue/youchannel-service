-- Quota System RLS Policies Migration
-- Task 3: Enable RLS and allow users to read their own data only
-- Design: docs/QUOTA_DESIGN.md (RLS section)
-- 
-- Write Strategy:
-- All writes to quota tables should go through:
-- 1. service_role client (bypasses RLS) - for backend jobs and admin operations
-- 2. RPC functions with SECURITY DEFINER - for controlled user-initiated actions
-- Normal users have SELECT access ONLY via RLS policies.

--------------------------------------------------------------------------------
-- Enable Row Level Security on all quota tables
--------------------------------------------------------------------------------
ALTER TABLE public.user_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quota_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quota_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quota_usage_splits ENABLE ROW LEVEL SECURITY;

--------------------------------------------------------------------------------
-- SELECT policies: Users can only view their own rows
--------------------------------------------------------------------------------

-- user_quotas: User can view their own quota cache
CREATE POLICY "Users can view own quotas"
  ON public.user_quotas
  FOR SELECT
  USING (auth.uid() = user_id);

-- quota_grants: User can view their own grants
CREATE POLICY "Users can view own grants"
  ON public.quota_grants
  FOR SELECT
  USING (auth.uid() = user_id);

-- quota_usage_events: User can view their own usage events
CREATE POLICY "Users can view own quota events"
  ON public.quota_usage_events
  FOR SELECT
  USING (auth.uid() = user_id);

-- quota_usage_splits: User can view splits for their own events
-- Note: The quota_usage_splits table has a user_id column for RLS performance
CREATE POLICY "Users can view own quota splits"
  ON public.quota_usage_splits
  FOR SELECT
  USING (auth.uid() = user_id);
