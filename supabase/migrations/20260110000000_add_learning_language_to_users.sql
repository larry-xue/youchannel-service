-- Add learning language to auth.users
ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS learning_language text DEFAULT '';
