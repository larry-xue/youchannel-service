-- 20260110100003_add_quota_cache_refresh.sql
-- Task 5: Cache refresh job for user_quotas
-- Implements functions to rebuild user_quotas cache from active grants.

--------------------------------------------------------------------------------
-- Function: refresh_user_quota
-- Refreshes the user_quotas cache for a single user.
-- Uses eligibility rules: status = 'active', valid_from <= now, valid_to >= now or NULL
-- Computes: total = SUM(grants total), remaining = SUM(grants remaining), max_video_seconds = MAX(grants max_video_seconds)
-- UPSERT into user_quotas (creates row if not exists).
-- Returns the user_id that was refreshed.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_user_quota(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_video_total bigint;
  v_video_remaining bigint;
  v_chat_total bigint;
  v_chat_remaining bigint;
  v_max_video_seconds bigint;
  v_period_start timestamptz;
  v_period_end timestamptz;
BEGIN
  -- Aggregate from active grants within validity window
  SELECT 
    COALESCE(SUM(video_seconds_total), 0),
    COALESCE(SUM(video_seconds_remaining), 0),
    COALESCE(SUM(chat_seconds_total), 0),
    COALESCE(SUM(chat_seconds_remaining), 0),
    COALESCE(MAX(max_video_seconds), 0),
    -- period_start = earliest valid_from among active grants
    MIN(valid_from),
    -- period_end = NULL if any active grant is open-ended; else latest valid_to
    CASE
      WHEN BOOL_OR(valid_to IS NULL) THEN NULL
      ELSE MAX(valid_to)
    END
  INTO 
    v_video_total,
    v_video_remaining,
    v_chat_total,
    v_chat_remaining,
    v_max_video_seconds,
    v_period_start,
    v_period_end
  FROM public.quota_grants
  WHERE user_id = p_user_id
    AND status = 'active'
    AND valid_from <= now()
    AND (valid_to IS NULL OR valid_to >= now());

  -- If no active grants, set defaults
  IF v_period_start IS NULL THEN
    v_period_start := now();
  END IF;

  -- UPSERT into user_quotas
  INSERT INTO public.user_quotas (
    user_id,
    video_seconds_total,
    video_seconds_remaining,
    chat_seconds_total,
    chat_seconds_remaining,
    max_video_seconds,
    period_start_at,
    period_end_at,
    created_at,
    updated_at
  ) VALUES (
    p_user_id,
    v_video_total,
    v_video_remaining,
    v_chat_total,
    v_chat_remaining,
    v_max_video_seconds,
    v_period_start,
    v_period_end,
    now(),
    now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    video_seconds_total = EXCLUDED.video_seconds_total,
    video_seconds_remaining = EXCLUDED.video_seconds_remaining,
    chat_seconds_total = EXCLUDED.chat_seconds_total,
    chat_seconds_remaining = EXCLUDED.chat_seconds_remaining,
    max_video_seconds = EXCLUDED.max_video_seconds,
    period_start_at = EXCLUDED.period_start_at,
    period_end_at = EXCLUDED.period_end_at,
    updated_at = now();

  RETURN p_user_id;
END;
$$;

--------------------------------------------------------------------------------
-- Function: refresh_all_user_quotas
-- Refreshes the user_quotas cache for ALL users that have grants.
-- Also cleans up users with no active grants (sets their cache to zero).
-- Returns the number of users refreshed.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_all_user_quotas()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user_id uuid;
  v_count integer := 0;
BEGIN
  -- Refresh all users who have any grants (active or not)
  FOR v_user_id IN
    SELECT DISTINCT user_id FROM public.quota_grants
  LOOP
    PERFORM public.refresh_user_quota(v_user_id);
    v_count := v_count + 1;
  END LOOP;

  -- Also refresh any users in user_quotas that may not have grants anymore
  -- (in case grants were deleted/revoked since last refresh)
  FOR v_user_id IN
    SELECT user_id FROM public.user_quotas
    WHERE user_id NOT IN (SELECT DISTINCT user_id FROM public.quota_grants)
  LOOP
    PERFORM public.refresh_user_quota(v_user_id);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

--------------------------------------------------------------------------------
-- Function: get_user_quota_summary
-- Convenience function to get a user's quota summary.
-- Returns fresh data computed from grants (not cache).
-- Useful for debugging or when fresh data is needed.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_user_quota_summary(p_user_id uuid)
RETURNS TABLE (
  video_seconds_total bigint,
  video_seconds_remaining bigint,
  video_seconds_used bigint,
  chat_seconds_total bigint,
  chat_seconds_remaining bigint,
  chat_seconds_used bigint,
  max_video_seconds bigint,
  active_grants_count bigint,
  period_start_at timestamptz,
  period_end_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COALESCE(SUM(g.video_seconds_total), 0)::bigint AS video_seconds_total,
    COALESCE(SUM(g.video_seconds_remaining), 0)::bigint AS video_seconds_remaining,
    (COALESCE(SUM(g.video_seconds_total), 0) - COALESCE(SUM(g.video_seconds_remaining), 0))::bigint AS video_seconds_used,
    COALESCE(SUM(g.chat_seconds_total), 0)::bigint AS chat_seconds_total,
    COALESCE(SUM(g.chat_seconds_remaining), 0)::bigint AS chat_seconds_remaining,
    (COALESCE(SUM(g.chat_seconds_total), 0) - COALESCE(SUM(g.chat_seconds_remaining), 0))::bigint AS chat_seconds_used,
    COALESCE(MAX(g.max_video_seconds), 0)::bigint AS max_video_seconds,
    COUNT(*)::bigint AS active_grants_count,
    MIN(g.valid_from) AS period_start_at,
    CASE
      WHEN BOOL_OR(g.valid_to IS NULL) THEN NULL
      ELSE MAX(g.valid_to)
    END AS period_end_at
  FROM public.quota_grants g
  WHERE g.user_id = p_user_id
    AND g.status = 'active'
    AND g.valid_from <= now()
    AND (g.valid_to IS NULL OR g.valid_to >= now());
END;
$$;

-- Grant execute permissions (service role can call these)
-- Note: These are SECURITY DEFINER functions, so they run with owner privileges.
-- The RLS policies don't block these since they bypass RLS via SECURITY DEFINER.
REVOKE ALL ON FUNCTION public.refresh_user_quota(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_all_user_quotas() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_user_quota_summary(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.refresh_user_quota(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_all_user_quotas() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_user_quota_summary(uuid) TO service_role;
