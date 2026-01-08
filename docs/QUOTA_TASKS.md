# Quota Design Implementation Tasks (Linear Plan)

This document breaks down the quota design into linear, 1-2 day tasks suitable for a junior developer. Follow tasks in order.

## Task 1 - Read and align on design
Goal: Ensure understanding before implementation.
- Read docs/QUOTA_DESIGN.md.
- Confirm scope: no data migration, new tables only.
- List open questions (if any) and confirm answers.
Acceptance:
- A brief note in the PR or ticket stating "Design understood, scope confirmed."

## Task 2 - Create migration for core tables + indexes
Goal: Add user_quotas, quota_grants, quota_usage_events, quota_usage_splits.
- Add SQL migration in supabase/migrations.
- Use now() for timestamptz defaults.
- Use bigint seconds and all CHECK constraints defined in design.
- Create indexes including partial indexes and events list index.
Acceptance:
- Migration applies cleanly in a local environment.
- Tables and indexes match docs/QUOTA_DESIGN.md.

## Task 3 - Add RLS policies
Goal: Enable RLS and allow users to read their own data only.
- ENABLE RLS on all four tables.
- Add SELECT policies per docs/QUOTA_DESIGN.md.
- Confirm no direct insert/update permissions for normal users.
Acceptance:
- RLS enabled with correct policies.
- Document how service_role or RPC will be used for writes.

## Task 4 - Implement RPC: consume and refund
Goal: Provide safe, idempotent quota operations.
- Create a SQL/PLpgSQL function:
  - Uses INSERT ... ON CONFLICT DO NOTHING RETURNING id for idempotency.
  - Uses SELECT ... FOR UPDATE to lock eligible grants.
  - Enforces max_video_seconds for video consumption.
  - Updates grant remaining with delta semantics.
  - Inserts usage events + splits.
  - Validates SUM(splits.*) == events.* in the transaction.
- Add unit/integration tests if available in this repo.
Acceptance:
- RPC returns a stable event id.
- Concurrent calls with same idempotency_key do not double-deduct.
- Negative remaining is prevented by constraints.

## Task 5 - Cache refresh job (user_quotas)
Goal: Build or update user_quotas as a rebuildable cache.
- Implement a SQL function or job to recompute totals from active grants.
- Use eligibility rules: status = 'active', valid_from/valid_to windows.
- Update user_quotas totals + remaining + max_video_seconds.
Acceptance:
- A single command/function can refresh a user_id.
- Cache can be fully rebuilt without touching ledger integrity.

## Task 6 - Application integration (read + enforce)
Goal: Wire the app to use the new system.
- Replace any old quota checks with:
  - max_video_seconds check from grants.
  - usage deductions via RPC.
- Ensure idempotency_key is passed from job/execution context.
Acceptance:
- Analysis/chat flows call the new RPC.
- Existing flows do not bypass grant checks.

## Task 7 - Admin / support tooling (minimal)
Goal: Allow manual adjustments and audit.
- Provide a minimal admin script or SQL snippet:
  - Add grants for a user.
  - Issue refunds via RPC or direct events.
- Document in docs/QUOTA_DESIGN.md or a new admin note.
Acceptance:
- A documented procedure exists for support to adjust quotas.

## Task 8 - Final review and cleanup
Goal: Verify expectations and update docs.
- Confirm all tasks are completed in order.
- Update docs/QUOTA_DESIGN.md with any implementation notes.
Acceptance:
- README or BUSINESS_LOGIC.md references the new quota system.
