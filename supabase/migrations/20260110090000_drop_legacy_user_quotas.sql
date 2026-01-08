-- Drop legacy user_quotas table before creating new quota system
-- The old table from 20250102020000_add_sync_support.sql has incompatible schema:
--   - Old: id (PK), user_id, analysis_count, max_analyses
--   - New: user_id (PK), video_seconds_total, video_seconds_remaining, etc.
--
-- Since the new quota system is a complete redesign, we drop the old table.
-- No data migration is needed as the old quota tracking is being replaced.

DROP TABLE IF EXISTS public.user_quotas CASCADE;
