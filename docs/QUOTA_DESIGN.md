# Quota and Usage Ledger Design

## Overview
This document defines the quota system for video analysis and chat usage. Quota is measured in seconds and enforced via lockable grants plus an append-only usage ledger. A lightweight per-user cache provides fast reads but is not the source of truth.

## Goals
- Support two resource types: video seconds and chat seconds.
- Enforce per-video maximum length via max_video_seconds.
- Provide auditable, refundable usage records with idempotency.
- Ensure safe concurrent deductions with row-level locking.
- Keep reads fast with a cache that can be rebuilt.

## Non-goals
- Product catalog or pricing rules.
- Migration from the existing quota model.

## Key decisions
- All durations use seconds and are stored as bigint.
- user_quotas is a cache only. Source of truth is quota_grants plus usage ledger.
- Delta semantics are unified: delta is applied to remaining.
  - consume: delta < 0
  - refund: delta > 0
  - adjust: delta can be any sign
- Expired and depleted are derived states, not stored, except for manual revoke.

## Data model

### user_quotas (cache only)
Stores current totals for fast reads. No "used" column to avoid drift.

```sql
CREATE TABLE public.user_quotas (
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
```

Derived value:
- video_seconds_used = video_seconds_total - video_seconds_remaining
- chat_seconds_used = chat_seconds_total - chat_seconds_remaining

### quota_grants (lockable grants)
Represents entitlement buckets from subscriptions, packages, or manual grants.

```sql
CREATE TABLE public.quota_grants (
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
```

Eligibility for a video consumption:
- status = 'active'
- valid_from <= now and (valid_to is null or valid_to >= now)
- video_seconds_remaining > 0
- max_video_seconds > 0
- if video_duration_seconds is provided, it must be <= max_video_seconds

### quota_usage_events (ledger header)
Represents a single business action. Delta is applied to remaining.

```sql
CREATE TABLE public.quota_usage_events (
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
```

Notes:
- For video consumption, record video_duration_seconds for audit.
- context can capture plan tier, model, or pricing factors.

### quota_usage_splits (ledger lines)
Breaks a single event into per-grant deltas.

```sql
CREATE TABLE public.quota_usage_splits (
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
```

## Indexes
```sql
CREATE UNIQUE INDEX IF NOT EXISTS quota_usage_events_idem_idx
  ON public.quota_usage_events (user_id, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS quota_usage_events_refund_idx
  ON public.quota_usage_events (user_id, (context->>'original_event_id'))
  WHERE event_type = 'refund';

CREATE INDEX IF NOT EXISTS quota_usage_events_user_created_idx
  ON public.quota_usage_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS quota_grants_video_consumable_idx
  ON public.quota_grants (user_id, consume_priority, valid_to)
  WHERE status = 'active' AND video_seconds_remaining > 0;

CREATE INDEX IF NOT EXISTS quota_grants_chat_consumable_idx
  ON public.quota_grants (user_id, consume_priority, valid_to)
  WHERE status = 'active' AND chat_seconds_remaining > 0;

CREATE INDEX IF NOT EXISTS quota_usage_splits_event_idx
  ON public.quota_usage_splits (event_id);

CREATE INDEX IF NOT EXISTS quota_usage_splits_grant_idx
  ON public.quota_usage_splits (grant_id);

CREATE INDEX IF NOT EXISTS quota_usage_splits_user_idx
  ON public.quota_usage_splits (user_id);
```

## Concurrency and idempotency
- All deductions and refunds run in a single transaction.
- Lock eligible grants using SELECT ... FOR UPDATE ordered by:
  consume_priority ASC, valid_to ASC NULLS LAST, created_at ASC.
- Idempotency uses a unique (user_id, idempotency_key) index.
- Insert event with ON CONFLICT DO NOTHING RETURNING id.
  - If not inserted, select the existing event and return immediately.

## Consumption flow (video or chat)
1. Begin transaction.
2. Insert quota_usage_events with negative deltas using ON CONFLICT DO NOTHING.
3. If conflict, return existing event id with no deduction.
4. SELECT eligible grants FOR UPDATE (type-specific remaining > 0).
5. For video, ensure max_video_seconds >= video_duration_seconds.
6. Apply deltas to grants: remaining = remaining + delta (delta is negative).
7. Insert quota_usage_splits for each grant used.
8. Validate sums in the transaction:
   - SUM(splits.video_seconds_delta) == events.video_seconds_delta
   - SUM(splits.chat_seconds_delta) == events.chat_seconds_delta
9. Commit.

## Refund flow
1. Begin transaction.
2. Insert quota_usage_events with positive deltas (refund).
3. Lock the original grants used (or select eligible grants).
4. Apply deltas to grants: remaining = remaining + delta (delta is positive).
5. Insert splits for the refund.
6. Validate sums and commit.

## Cache refresh strategy
user_quotas is a cache. Rebuild from grants periodically or on-demand:
- total = sum(active grants total within validity window)
- remaining = sum(active grants remaining within validity window)
- max_video_seconds = max(active grants max_video_seconds within validity window)
- period_start_at = MIN(valid_from) across active grants (fallback to now() when none)
- period_end_at = NULL if any active grant is open-ended, else MAX(valid_to)

The cache can be refreshed asynchronously; do not rely on it for enforcing limits.

## Status and expiration
- valid_from/valid_to determine eligibility at query time.
- status is only used for manual revoke.
- Expired or depleted is derived and not stored.

## RLS (Supabase)
Enable RLS on all quota tables. Users can only SELECT their own rows.
All writes should go through service role or an RPC function.

```sql
ALTER TABLE public.user_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quota_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quota_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quota_usage_splits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own quotas"
  ON public.user_quotas FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can view own grants"
  ON public.quota_grants FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can view own quota events"
  ON public.quota_usage_events FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can view own quota splits"
  ON public.quota_usage_splits FOR SELECT USING (auth.uid() = user_id);
```

## Implementation notes
- quota_usage_splits includes user_id for RLS performance; keep it aligned with quota_usage_events.user_id.
- consume_quota rejects negative inputs and requires at least one non-zero delta.
- max_video_seconds = 0 means a grant is not usable for video; if video_duration_seconds is provided it must be <= max_video_seconds.
- refund_quota refunds to the exact same grants via splits and uses a unique index on (user_id, context->>'original_event_id') to prevent double refunds.
- Cache refresh helpers exist: refresh_user_quota, refresh_all_user_quotas, get_user_quota_summary (see supabase/migrations/20260110100003_add_quota_cache_refresh.sql).
- Verification scripts live in supabase/tests/verify_quota_rpc.sql and supabase/tests/verify_quota_cache_refresh.sql.
- Legacy user_quotas (analysis_count/max_analyses) is dropped in supabase/migrations/20260110090000_drop_legacy_user_quotas.sql.

## Open questions
- Do we want to enforce a non-null video_duration_seconds when reason = 'video_analysis'?
- Do we need a dedicated product catalog table for subscription and package definitions?
