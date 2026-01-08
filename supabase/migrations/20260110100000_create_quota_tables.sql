-- Quota System Tables Migration
-- Design: docs/QUOTA_DESIGN.md
-- Scope: New tables only, no data migration

--------------------------------------------------------------------------------
-- user_quotas (cache only)
-- Stores current totals for fast reads. Source of truth is quota_grants + ledger.
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_quotas (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,

  video_seconds_total bigint NOT NULL DEFAULT 0,
  video_seconds_remaining bigint NOT NULL DEFAULT 0,
  chat_seconds_total bigint NOT NULL DEFAULT 0,
  chat_seconds_remaining bigint NOT NULL DEFAULT 0,

  max_video_seconds bigint NOT NULL DEFAULT 0,

  period_start_at timestamptz NOT NULL DEFAULT now(),
  period_end_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT user_quotas_video_range CHECK (
    video_seconds_total >= 0 AND
    video_seconds_remaining >= 0 AND
    video_seconds_remaining <= video_seconds_total
  ),
  CONSTRAINT user_quotas_chat_range CHECK (
    chat_seconds_total >= 0 AND
    chat_seconds_remaining >= 0 AND
    chat_seconds_remaining <= chat_seconds_total
  ),
  CONSTRAINT user_quotas_max_video_nonneg CHECK (max_video_seconds >= 0)
);

--------------------------------------------------------------------------------
-- quota_grants (lockable grants)
-- Represents entitlement buckets from subscriptions, packages, or manual grants.
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.quota_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,

  source_type text NOT NULL
    CHECK (source_type IN ('subscription', 'package', 'manual', 'promo')),
  source_ref text,

  video_seconds_total bigint NOT NULL DEFAULT 0,
  video_seconds_remaining bigint NOT NULL DEFAULT 0,
  chat_seconds_total bigint NOT NULL DEFAULT 0,
  chat_seconds_remaining bigint NOT NULL DEFAULT 0,

  max_video_seconds bigint NOT NULL DEFAULT 0,

  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,

  consume_priority integer NOT NULL DEFAULT 100,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),

  version integer NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quota_grants_valid_range CHECK (
    valid_to IS NULL OR valid_to >= valid_from
  ),
  CONSTRAINT quota_grants_video_range CHECK (
    video_seconds_total >= 0 AND
    video_seconds_remaining >= 0 AND
    video_seconds_remaining <= video_seconds_total
  ),
  CONSTRAINT quota_grants_chat_range CHECK (
    chat_seconds_total >= 0 AND
    chat_seconds_remaining >= 0 AND
    chat_seconds_remaining <= chat_seconds_total
  ),
  CONSTRAINT quota_grants_max_video_nonneg CHECK (max_video_seconds >= 0)
);

--------------------------------------------------------------------------------
-- quota_usage_events (ledger header)
-- Represents a single business action. Delta is applied to remaining.
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.quota_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,

  event_type text NOT NULL
    CHECK (event_type IN ('consume', 'refund', 'adjust')),

  reason text,
  reference_type text,
  reference_id text,

  video_seconds_delta bigint NOT NULL DEFAULT 0,
  chat_seconds_delta bigint NOT NULL DEFAULT 0,

  video_duration_seconds bigint,
  context jsonb,

  idempotency_key text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quota_usage_events_nonzero CHECK (
    video_seconds_delta <> 0 OR chat_seconds_delta <> 0
  ),
  CONSTRAINT quota_usage_events_sign CHECK (
    (event_type = 'consume' AND video_seconds_delta <= 0 AND chat_seconds_delta <= 0) OR
    (event_type = 'refund' AND video_seconds_delta >= 0 AND chat_seconds_delta >= 0) OR
    (event_type = 'adjust')
  )
);

--------------------------------------------------------------------------------
-- quota_usage_splits (ledger lines)
-- Breaks a single event into per-grant deltas.
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.quota_usage_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.quota_usage_events (id) ON DELETE CASCADE,
  grant_id uuid NOT NULL REFERENCES public.quota_grants (id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,

  video_seconds_delta bigint NOT NULL DEFAULT 0,
  chat_seconds_delta bigint NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quota_usage_splits_nonzero CHECK (
    video_seconds_delta <> 0 OR chat_seconds_delta <> 0
  )
);

--------------------------------------------------------------------------------
-- Indexes
--------------------------------------------------------------------------------

-- Idempotency index for events (unique per user + key)
CREATE UNIQUE INDEX IF NOT EXISTS quota_usage_events_idem_idx
  ON public.quota_usage_events (user_id, idempotency_key);

-- Events list index (for user event history)
CREATE INDEX IF NOT EXISTS quota_usage_events_user_created_idx
  ON public.quota_usage_events (user_id, created_at DESC);

-- Partial index for video-consumable grants (active grants with remaining video seconds)
CREATE INDEX IF NOT EXISTS quota_grants_video_consumable_idx
  ON public.quota_grants (user_id, consume_priority, valid_to)
  WHERE status = 'active' AND video_seconds_remaining > 0;

-- Partial index for chat-consumable grants (active grants with remaining chat seconds)
CREATE INDEX IF NOT EXISTS quota_grants_chat_consumable_idx
  ON public.quota_grants (user_id, consume_priority, valid_to)
  WHERE status = 'active' AND chat_seconds_remaining > 0;

-- Splits by event (for loading splits by event)
CREATE INDEX IF NOT EXISTS quota_usage_splits_event_idx
  ON public.quota_usage_splits (event_id);

-- Splits by grant (for loading splits by grant)
CREATE INDEX IF NOT EXISTS quota_usage_splits_grant_idx
  ON public.quota_usage_splits (grant_id);

-- Splits by user (for RLS performance)
CREATE INDEX IF NOT EXISTS quota_usage_splits_user_idx
  ON public.quota_usage_splits (user_id);
