-- Fix jobs dedupe_key constraint to support upsert with onConflict
-- The partial unique index cannot be used by Supabase's upsert onConflict parameter
-- We need a unique constraint instead

-- Drop the partial unique index first
DROP INDEX IF EXISTS public.jobs_dedupe_key_uniq;

-- Add a unique constraint (PostgreSQL allows multiple NULLs in unique constraints)
-- This will work with Supabase's upsert onConflict parameter
-- Note: Multiple NULL values are allowed, which is fine for our use case
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jobs_dedupe_key_uniq'
    AND conrelid = 'public.jobs'::regclass
  ) THEN
    ALTER TABLE public.jobs
      ADD CONSTRAINT jobs_dedupe_key_uniq UNIQUE (dedupe_key);
  END IF;
END $$;
