-- verify_quota_rpc.sql
-- Run this in the Supabase SQL Editor to verify the quota RPC functions.

BEGIN;

-- 1. Setup Test User
DO $$
DECLARE
  v_user_id uuid := '00000000-0000-0000-0000-000000000001';
  v_grant_id uuid;
  v_consume_event_id uuid;
  v_refund_event_id uuid;
BEGIN
  RAISE NOTICE 'Starting Verification...';

  -- Clean up if exists (for re-runnability)
  DELETE FROM public.quota_grants WHERE user_id = v_user_id;
  DELETE FROM public.quota_usage_events WHERE user_id = v_user_id;
  
  -- Create a test grant (1000s video, 60s max)
  INSERT INTO public.quota_grants (
    user_id,
    source_type,
    video_seconds_total,
    video_seconds_remaining,
    chat_seconds_total,
    chat_seconds_remaining,
    max_video_seconds,
    valid_from,
    status
  ) VALUES (
    v_user_id,
    'manual',
    1000,
    1000,
    500,
    500,
    600,
    now() - interval '1 day',
    'active'
  ) RETURNING id INTO v_grant_id;
  
  RAISE NOTICE 'Created Grant: %', v_grant_id;

  -- 2. Test Consumption (Success)
  v_consume_event_id := public.consume_quota(
    p_user_id := v_user_id,
    p_video_seconds := 100,
    p_chat_seconds := 50,
    p_video_duration_seconds := 60, -- Fits in max 600
    p_idempotency_key := 'test-consume-1'
  );
  
  RAISE NOTICE 'Consumed (idempotency key 1) Event ID: %', v_consume_event_id;

  -- Check remaining
  PERFORM * FROM public.quota_grants 
  WHERE id = v_grant_id 
    AND video_seconds_remaining = 900 
    AND chat_seconds_remaining = 450;
    
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consumption failed: Incorrect remaining balance';
  END IF;

  -- 2.1 Test Max Duration Failure
  BEGIN
    PERFORM public.consume_quota(
      p_user_id := v_user_id,
      p_video_seconds := 10,
      p_chat_seconds := 0,
      p_video_duration_seconds := 700, -- Exceeds 600
      p_idempotency_key := 'test-fail-max'
    );
    RAISE EXCEPTION 'Should have failed due to max duration check';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Correctly failed max duration check: %', SQLERRM;
  END;

  -- 3. Test Idempotency with Mismatch (Should Fail)
  BEGIN
    PERFORM public.consume_quota(
      p_user_id := v_user_id,
      p_video_seconds := 999, -- Different amount
      p_chat_seconds := 50,
      p_video_duration_seconds := 60,
      p_idempotency_key := 'test-consume-1' -- SAME KEY
    );
    RAISE EXCEPTION 'Should have failed due to idempotency parameter mismatch';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Correctly failed idempotency mismatch: %', SQLERRM;
  END;

  -- 4. Test Refund (New Signature)
  v_refund_event_id := public.refund_quota(
    p_user_id := v_user_id,
    p_original_event_id := v_consume_event_id,
    p_idempotency_key := 'test-refund-1'
  );
  
  RAISE NOTICE 'Refunded (idempotency key 1) Event ID: %', v_refund_event_id;

  -- Check remaining (should be back to full)
  PERFORM * FROM public.quota_grants 
  WHERE id = v_grant_id 
    AND video_seconds_remaining = 1000 
    AND chat_seconds_remaining = 500;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Refund failed: Incorrect remaining balance (expected full refill)';
  END IF;

  -- 5. Test Double Refund (Should Fail)
  BEGIN
    PERFORM public.refund_quota(
      p_user_id := v_user_id,
      p_original_event_id := v_consume_event_id, -- Same original ID
      p_idempotency_key := 'test-refund-2' -- Different key, but same target
    );
    RAISE EXCEPTION 'Should have failed due to double refund check';
  EXCEPTION WHEN unique_violation THEN
     RAISE NOTICE 'Correctly failed double refund (Unique Index)';
  WHEN OTHERS THEN
     RAISE NOTICE 'Correctly failed double refund: %', SQLERRM;
  END;

  RAISE NOTICE 'Verification SUCCESS!';
  
END;
$$;

ROLLBACK; -- Always rollback the test data
