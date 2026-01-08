-- Verification tests for quota cache refresh functions
-- Run with: psql -f supabase/tests/verify_quota_cache_refresh.sql

-- Setup: Create a test user
DO $$
DECLARE
  v_test_user_id uuid := '00000000-0000-0000-0000-000000000099';
  v_grant1_id uuid;
  v_grant2_id uuid;
  v_result uuid;
  v_count integer;
  v_quota RECORD;
BEGIN
  RAISE NOTICE '========================================';
  RAISE NOTICE 'TEST: Quota Cache Refresh Functions';
  RAISE NOTICE '========================================';

  -- Clean up any existing test data
  DELETE FROM public.user_quotas WHERE user_id = v_test_user_id;
  DELETE FROM public.quota_grants WHERE user_id = v_test_user_id;

  -- -------------------------------------------------------------------
  -- TEST 1: refresh_user_quota with no grants
  -- -------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE 'TEST 1: Refresh with no grants';
  
  v_result := public.refresh_user_quota(v_test_user_id);
  
  SELECT * INTO v_quota FROM public.user_quotas WHERE user_id = v_test_user_id;
  
  ASSERT v_quota.video_seconds_total = 0, 
    'Expected video_seconds_total = 0, got ' || v_quota.video_seconds_total;
  ASSERT v_quota.video_seconds_remaining = 0, 
    'Expected video_seconds_remaining = 0';
  ASSERT v_quota.chat_seconds_total = 0, 
    'Expected chat_seconds_total = 0';
  ASSERT v_quota.max_video_seconds = 0, 
    'Expected max_video_seconds = 0';
  
  RAISE NOTICE '  PASS: User quota created with zeros when no grants exist';

  -- -------------------------------------------------------------------
  -- TEST 2: Add first grant and refresh
  -- -------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE 'TEST 2: Add grant and refresh';
  
  INSERT INTO public.quota_grants (
    id, user_id, source_type, 
    video_seconds_total, video_seconds_remaining,
    chat_seconds_total, chat_seconds_remaining,
    max_video_seconds, status, valid_from, valid_to
  ) VALUES (
    gen_random_uuid(), v_test_user_id, 'manual',
    3600, 3000,  -- 1hr total, 50min remaining
    7200, 7200,  -- 2hr total, 2hr remaining
    600,         -- 10 min max video
    'active', now() - interval '1 day', now() + interval '30 days'
  ) RETURNING id INTO v_grant1_id;
  
  v_result := public.refresh_user_quota(v_test_user_id);
  
  SELECT * INTO v_quota FROM public.user_quotas WHERE user_id = v_test_user_id;
  
  ASSERT v_quota.video_seconds_total = 3600, 
    'Expected video_seconds_total = 3600, got ' || v_quota.video_seconds_total;
  ASSERT v_quota.video_seconds_remaining = 3000, 
    'Expected video_seconds_remaining = 3000, got ' || v_quota.video_seconds_remaining;
  ASSERT v_quota.chat_seconds_total = 7200, 
    'Expected chat_seconds_total = 7200';
  ASSERT v_quota.chat_seconds_remaining = 7200, 
    'Expected chat_seconds_remaining = 7200';
  ASSERT v_quota.max_video_seconds = 600, 
    'Expected max_video_seconds = 600';
  
  RAISE NOTICE '  PASS: Single grant values correctly reflected in cache';

  -- -------------------------------------------------------------------
  -- TEST 3: Add second grant and verify aggregation
  -- -------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE 'TEST 3: Multiple grants aggregation';
  
  INSERT INTO public.quota_grants (
    id, user_id, source_type,
    video_seconds_total, video_seconds_remaining,
    chat_seconds_total, chat_seconds_remaining,
    max_video_seconds, status, valid_from, valid_to
  ) VALUES (
    gen_random_uuid(), v_test_user_id, 'subscription',
    1800, 1800,  -- 30min total, 30min remaining
    3600, 1800,  -- 1hr total, 30min remaining
    1800,        -- 30 min max video (higher than first grant)
    'active', now() - interval '1 day', now() + interval '60 days'
  ) RETURNING id INTO v_grant2_id;
  
  v_result := public.refresh_user_quota(v_test_user_id);
  
  SELECT * INTO v_quota FROM public.user_quotas WHERE user_id = v_test_user_id;
  
  -- Totals should be SUM
  ASSERT v_quota.video_seconds_total = 5400, 
    'Expected video_seconds_total = 5400 (3600+1800), got ' || v_quota.video_seconds_total;
  ASSERT v_quota.video_seconds_remaining = 4800, 
    'Expected video_seconds_remaining = 4800 (3000+1800), got ' || v_quota.video_seconds_remaining;
  ASSERT v_quota.chat_seconds_total = 10800, 
    'Expected chat_seconds_total = 10800 (7200+3600)';
  ASSERT v_quota.chat_seconds_remaining = 9000, 
    'Expected chat_seconds_remaining = 9000 (7200+1800)';
  -- max_video_seconds should be MAX
  ASSERT v_quota.max_video_seconds = 1800, 
    'Expected max_video_seconds = 1800 (max of 600, 1800), got ' || v_quota.max_video_seconds;
  
  RAISE NOTICE '  PASS: Multiple grants aggregated correctly (SUM for totals, MAX for max_video_seconds)';

  -- -------------------------------------------------------------------
  -- TEST 4: Open-ended grant sets period_end_at to NULL
  -- -------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE 'TEST 4: Open-ended grants set period_end_at to NULL';

  UPDATE public.quota_grants
  SET valid_to = NULL
  WHERE id = v_grant2_id;

  v_result := public.refresh_user_quota(v_test_user_id);

  SELECT * INTO v_quota FROM public.user_quotas WHERE user_id = v_test_user_id;

  ASSERT v_quota.period_end_at IS NULL,
    'Expected period_end_at = NULL when any grant is open-ended';

  RAISE NOTICE '  PASS: Open-ended grant sets period_end_at to NULL';

  -- -------------------------------------------------------------------
  -- TEST 5: Inactive grant should be excluded
  -- -------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE 'TEST 5: Inactive grants excluded';
  
  -- Revoke the second grant
  UPDATE public.quota_grants SET status = 'revoked' WHERE id = v_grant2_id;
  
  v_result := public.refresh_user_quota(v_test_user_id);
  
  SELECT * INTO v_quota FROM public.user_quotas WHERE user_id = v_test_user_id;
  
  -- Should only reflect first grant now
  ASSERT v_quota.video_seconds_total = 3600, 
    'Expected video_seconds_total = 3600 after revoke, got ' || v_quota.video_seconds_total;
  ASSERT v_quota.max_video_seconds = 600, 
    'Expected max_video_seconds = 600 after revoke, got ' || v_quota.max_video_seconds;
  
  RAISE NOTICE '  PASS: Revoked grants correctly excluded from cache';

  -- -------------------------------------------------------------------
  -- TEST 6: Expired grant should be excluded
  -- -------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE 'TEST 6: Expired grants excluded';
  
  -- Re-activate grant2 but set it as expired
  UPDATE public.quota_grants 
  SET status = 'active', 
      valid_to = now() - interval '1 day'
  WHERE id = v_grant2_id;
  
  v_result := public.refresh_user_quota(v_test_user_id);
  
  SELECT * INTO v_quota FROM public.user_quotas WHERE user_id = v_test_user_id;
  
  -- Should still only reflect first grant (grant2 is expired)
  ASSERT v_quota.video_seconds_total = 3600, 
    'Expected video_seconds_total = 3600 (expired grant excluded), got ' || v_quota.video_seconds_total;
  
  RAISE NOTICE '  PASS: Expired grants correctly excluded from cache';

  -- -------------------------------------------------------------------
  -- TEST 7: Future grant should be excluded
  -- -------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE 'TEST 7: Future grants excluded';
  
  -- Set grant2 to start in the future
  UPDATE public.quota_grants 
  SET valid_from = now() + interval '1 day',
      valid_to = now() + interval '30 days'
  WHERE id = v_grant2_id;
  
  v_result := public.refresh_user_quota(v_test_user_id);
  
  SELECT * INTO v_quota FROM public.user_quotas WHERE user_id = v_test_user_id;
  
  -- Should still only reflect first grant (grant2 hasn't started yet)
  ASSERT v_quota.video_seconds_total = 3600, 
    'Expected video_seconds_total = 3600 (future grant excluded), got ' || v_quota.video_seconds_total;
  
  RAISE NOTICE '  PASS: Future grants correctly excluded from cache';

  -- -------------------------------------------------------------------
  -- TEST 8: get_user_quota_summary returns accurate data
  -- -------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE 'TEST 8: get_user_quota_summary function';
  
  -- Make grant2 active again
  UPDATE public.quota_grants 
  SET valid_from = now() - interval '1 day',
      valid_to = now() + interval '30 days'
  WHERE id = v_grant2_id;
  
  DECLARE
    v_summary RECORD;
  BEGIN
    SELECT * INTO v_summary FROM public.get_user_quota_summary(v_test_user_id);
    
    ASSERT v_summary.video_seconds_total = 5400, 
      'get_user_quota_summary: Expected video_seconds_total = 5400, got ' || v_summary.video_seconds_total;
    ASSERT v_summary.video_seconds_used = 600, 
      'get_user_quota_summary: Expected video_seconds_used = 600 (5400-4800), got ' || v_summary.video_seconds_used;
    ASSERT v_summary.active_grants_count = 2, 
      'get_user_quota_summary: Expected active_grants_count = 2, got ' || v_summary.active_grants_count;
    
    RAISE NOTICE '  PASS: get_user_quota_summary returns accurate computed values';
  END;

  -- -------------------------------------------------------------------
  -- TEST 9: refresh_all_user_quotas
  -- -------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE 'TEST 9: refresh_all_user_quotas';
  
  v_count := public.refresh_all_user_quotas();
  
  ASSERT v_count >= 1, 
    'Expected refresh_all_user_quotas to return >= 1, got ' || v_count;
  
  RAISE NOTICE '  PASS: refresh_all_user_quotas processed % users', v_count;

  -- -------------------------------------------------------------------
  -- Cleanup
  -- -------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE 'Cleaning up test data...';
  DELETE FROM public.user_quotas WHERE user_id = v_test_user_id;
  DELETE FROM public.quota_grants WHERE user_id = v_test_user_id;

  RAISE NOTICE '';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'ALL TESTS PASSED!';
  RAISE NOTICE '========================================';
END;
$$;
