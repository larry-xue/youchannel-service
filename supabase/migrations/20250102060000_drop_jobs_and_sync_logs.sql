-- Drop jobs and sync_logs tables
-- This migration removes the jobs queue table and sync_logs tracking table

-- 1. Drop function that depends on jobs table
DROP FUNCTION IF EXISTS public.claim_job(text, text[], integer);

-- 2. Drop jobs table (triggers, indexes, and constraints will be automatically dropped)
DROP TABLE IF EXISTS public.jobs CASCADE;

-- 3. Drop RLS policies for sync_logs
DROP POLICY IF EXISTS "Users can view their sync logs" ON public.sync_logs;

-- 4. Drop sync_logs table (indexes, constraints, and foreign keys will be automatically dropped)
DROP TABLE IF EXISTS public.sync_logs CASCADE;
