-- 20260110100002_add_quota_rpc.sql

-- Index to prevent double refunds: (user_id, original_event_id)
CREATE UNIQUE INDEX IF NOT EXISTS quota_usage_events_refund_idx
  ON public.quota_usage_events (user_id, (context->>'original_event_id'))
  WHERE event_type = 'refund';

-- Function: consume_quota
-- Consumes quota for video or chat usage.
-- Guarantees idempotency via (user_id, idempotency_key).
-- Locks grants to prevent concurrent over-consumption.
-- Strict Max Video Seconds: quota_grants.max_video_seconds = 0 means NOT usable for video.
-- Search Path: pg_catalog, public for security.
CREATE OR REPLACE FUNCTION public.consume_quota(
  p_user_id uuid,
  p_video_seconds bigint,
  p_chat_seconds bigint,
  p_video_duration_seconds bigint,
  p_idempotency_key text,
  p_reason text DEFAULT NULL,
  p_reference_type text DEFAULT NULL,
  p_reference_id text DEFAULT NULL,
  p_context jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event_id uuid;
  v_existing_event RECORD;
  v_remaining_video_needed bigint := p_video_seconds;
  v_remaining_chat_needed bigint := p_chat_seconds;
  v_grant RECORD;
  v_deduct_video bigint;
  v_deduct_chat bigint;
BEGIN
  -- 1. Input validation
  IF p_video_seconds < 0 OR p_chat_seconds < 0 THEN
    RAISE EXCEPTION 'Consumption amounts must be non-negative';
  END IF;
  
  IF p_video_seconds = 0 AND p_chat_seconds = 0 THEN
     RAISE EXCEPTION 'Must consume at least some video or chat seconds';
  END IF;

  -- 2. Idempotency handling (Concurrent-safe INSERT ON CONFLICT)
  INSERT INTO public.quota_usage_events (
    user_id,
    event_type,
    reason,
    reference_type,
    reference_id,
    video_seconds_delta,
    chat_seconds_delta,
    video_duration_seconds,
    context,
    idempotency_key
  ) VALUES (
    p_user_id,
    'consume',
    p_reason,
    p_reference_type,
    p_reference_id,
    -p_video_seconds, -- stored as negative delta
    -p_chat_seconds,  -- stored as negative delta
    p_video_duration_seconds,
    p_context,
    p_idempotency_key
  )
  ON CONFLICT (user_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_event_id;

  -- If ID matched, it's a new event. If null, it already exists.
  IF v_event_id IS NULL THEN
    -- Retrieve existing event
    SELECT * INTO v_existing_event
    FROM public.quota_usage_events
    WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;

    -- Strict consistency check
    IF v_existing_event.event_type <> 'consume' OR
       v_existing_event.video_seconds_delta <> -p_video_seconds OR
       v_existing_event.chat_seconds_delta <> -p_chat_seconds OR
       (v_existing_event.video_duration_seconds IS DISTINCT FROM p_video_duration_seconds) OR
       (v_existing_event.reference_id IS DISTINCT FROM p_reference_id) THEN
       RAISE EXCEPTION 'Idempotency conflict: Parameters do not match existing event %', v_existing_event.id;
    END IF;
    
    RETURN v_existing_event.id;
  END IF;

  -- 3. Lock and consume grants
  FOR v_grant IN
    SELECT *
    FROM public.quota_grants
    WHERE user_id = p_user_id
      AND status = 'active'
      AND valid_from <= now()
      AND (valid_to IS NULL OR valid_to >= now())
      AND (
        (v_remaining_video_needed > 0 AND video_seconds_remaining > 0) OR
        (v_remaining_chat_needed > 0 AND chat_seconds_remaining > 0)
      )
    ORDER BY consume_priority ASC, valid_to ASC NULLS LAST, created_at ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining_video_needed <= 0 AND v_remaining_chat_needed <= 0;

    v_deduct_video := 0;
    v_deduct_chat := 0;

    -- Video check & deduction
    IF v_remaining_video_needed > 0 AND v_grant.video_seconds_remaining > 0 THEN
       -- STRICT SEMANTICS:
       -- 1. If max_video_seconds == 0, this grant CANNOT be used for video.
       -- 2. If max_video_seconds > 0, it MUST be >= p_video_duration_seconds.
       
       IF v_grant.max_video_seconds = 0 THEN
          -- Not usable for video
          NULL;
       ELSIF p_video_duration_seconds IS NOT NULL AND v_grant.max_video_seconds < p_video_duration_seconds THEN
          -- Not sufficient for this video length
          NULL;
       ELSE
          -- Eligible
          v_deduct_video := LEAST(v_remaining_video_needed, v_grant.video_seconds_remaining);
       END IF;
    END IF;

    -- Chat deduction
    IF v_remaining_chat_needed > 0 AND v_grant.chat_seconds_remaining > 0 THEN
      v_deduct_chat := LEAST(v_remaining_chat_needed, v_grant.chat_seconds_remaining);
    END IF;

    -- Update grant
    IF v_deduct_video > 0 OR v_deduct_chat > 0 THEN
      UPDATE public.quota_grants
      SET 
        video_seconds_remaining = video_seconds_remaining - v_deduct_video,
        chat_seconds_remaining = chat_seconds_remaining - v_deduct_chat,
        updated_at = now()
      WHERE id = v_grant.id;

      -- Insert split
      INSERT INTO public.quota_usage_splits (
        event_id,
        grant_id,
        user_id,
        video_seconds_delta,
        chat_seconds_delta
      ) VALUES (
        v_event_id,
        v_grant.id,
        p_user_id,
        -v_deduct_video, -- stored as negative
        -v_deduct_chat   -- stored as negative
      );

      v_remaining_video_needed := v_remaining_video_needed - v_deduct_video;
      v_remaining_chat_needed := v_remaining_chat_needed - v_deduct_chat;
    END IF;
  END LOOP;

  -- 4. Check if satisfied
  IF v_remaining_video_needed > 0 THEN
     RAISE EXCEPTION 'Insufficient video quota. Missing % seconds. (Check max_video_seconds rules)', v_remaining_video_needed;
  END IF;

  IF v_remaining_chat_needed > 0 THEN
     RAISE EXCEPTION 'Insufficient chat quota. Missing % seconds.', v_remaining_chat_needed;
  END IF;

  RETURN v_event_id;
END;
$$;


-- Function: refund_quota
-- Refunds quota based on an ORIGINAL consume event.
-- Guaranteed to refund to the EXACT SAME grants.
-- Prevents double refunds via unique index.
-- Search Path: pg_catalog, public.
CREATE OR REPLACE FUNCTION public.refund_quota(
  p_user_id uuid,
  p_original_event_id uuid,
  p_idempotency_key text,
  p_reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_refund_event_id uuid;
  v_existing_event RECORD;
  v_original_event RECORD;
  v_split RECORD;
  v_refund_video bigint := 0;
  v_refund_chat bigint := 0;
  v_split_refund_video bigint;
  v_split_refund_chat bigint;
  v_total_refunded_video bigint := 0;
  v_total_refunded_chat bigint := 0;
BEGIN
  -- 1. Get Original Event & Calculate Deltas
  SELECT * INTO v_original_event
  FROM public.quota_usage_events
  WHERE id = p_original_event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Original event not found';
  END IF;

  IF v_original_event.user_id <> p_user_id THEN
    RAISE EXCEPTION 'Original event belongs to different user';
  END IF;
  
  IF v_original_event.event_type <> 'consume' THEN
    RAISE EXCEPTION 'Original event must be of type consume';
  END IF;

  v_refund_video := -v_original_event.video_seconds_delta;
  v_refund_chat := -v_original_event.chat_seconds_delta;

  -- 2. Idempotency handling (Concurrent-safe INSERT ON CONFLICT)
  INSERT INTO public.quota_usage_events (
    user_id,
    event_type,
    reason,
    video_seconds_delta,
    chat_seconds_delta,
    context,
    idempotency_key
  ) VALUES (
    p_user_id,
    'refund',
    p_reason,
    v_refund_video,
    v_refund_chat,
    jsonb_build_object('original_event_id', p_original_event_id),
    p_idempotency_key
  )
  ON CONFLICT (user_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_refund_event_id;

  IF v_refund_event_id IS NULL THEN
     SELECT * INTO v_existing_event
     FROM public.quota_usage_events
     WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;

     -- Check if it matches original_event_id
     IF (v_existing_event.context->>'original_event_id')::uuid IS DISTINCT FROM p_original_event_id THEN
        RAISE EXCEPTION 'Idempotency conflict: original_event_id mismatch';
     END IF;
     RETURN v_existing_event.id;
  END IF;

  -- 3. Process Splits: Reverse each split
  -- Lock grants in order to prevent deadlocks (ORDER BY grant_id)
  FOR v_split IN
    SELECT * 
    FROM public.quota_usage_splits 
    WHERE event_id = p_original_event_id
    ORDER BY grant_id ASC
  LOOP
    -- Calculate refund amount for this split
    v_split_refund_video := -v_split.video_seconds_delta; -- was negative, now positive
    v_split_refund_chat := -v_split.chat_seconds_delta;   -- was negative, now positive

    -- Lock Grant
    PERFORM 1 FROM public.quota_grants WHERE id = v_split.grant_id FOR UPDATE;

    -- Update Grant
    UPDATE public.quota_grants
    SET 
        video_seconds_remaining = video_seconds_remaining + v_split_refund_video,
        chat_seconds_remaining = chat_seconds_remaining + v_split_refund_chat,
        updated_at = now()
    WHERE id = v_split.grant_id;

    -- Strict Overflow Check
    PERFORM 1
    FROM public.quota_grants
    WHERE id = v_split.grant_id
      AND (video_seconds_remaining > video_seconds_total OR chat_seconds_remaining > chat_seconds_total);
      
    IF FOUND THEN
       RAISE EXCEPTION 'Refund failed: Grant % capacity exceeded. Manual intervention required.', v_split.grant_id;
    END IF;

    -- Insert Refund Split
    INSERT INTO public.quota_usage_splits (
      event_id,
      grant_id,
      user_id,
      video_seconds_delta,
      chat_seconds_delta
    ) VALUES (
      v_refund_event_id,
      v_split.grant_id,
      p_user_id,
      v_split_refund_video,
      v_split_refund_chat
    );
    
    v_total_refunded_video := v_total_refunded_video + v_split_refund_video;
    v_total_refunded_chat := v_total_refunded_chat + v_split_refund_chat;
  END LOOP;

  -- 4. Final Sum Check
  IF v_total_refunded_video <> v_refund_video OR v_total_refunded_chat <> v_refund_chat THEN
     RAISE EXCEPTION 'Refund integrity check failed: Splits sum (%/%) does not match Event delta (%/%)', 
       v_total_refunded_video, v_total_refunded_chat, v_refund_video, v_refund_chat;
  END IF;

  RETURN v_refund_event_id;
END;
$$;
