-- Move videos ownership to user, drop playlist binding in analyses

-- videos: add user_id and backfill from playlists
ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS user_id uuid;

UPDATE public.videos v
SET user_id = p.user_id
FROM public.playlists p
WHERE v.playlist_id = p.id
  AND v.user_id IS NULL;

ALTER TABLE public.videos
  ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE public.videos
  ADD CONSTRAINT videos_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES auth.users (id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS videos_user_id_idx ON public.videos (user_id);

-- videos: drop existing RLS policies that depend on playlist_id
DROP POLICY IF EXISTS "Users can view their videos" ON public.videos;
DROP POLICY IF EXISTS "Users can insert their videos" ON public.videos;
DROP POLICY IF EXISTS "Users can update their videos" ON public.videos;
DROP POLICY IF EXISTS "Users can delete their videos" ON public.videos;

-- videos: drop playlist_id column entirely
ALTER TABLE public.videos
  DROP CONSTRAINT IF EXISTS videos_playlist_id_fkey;

ALTER TABLE public.videos
  DROP COLUMN IF EXISTS playlist_id;

-- videos: enforce uniqueness per user
ALTER TABLE public.videos
  DROP CONSTRAINT IF EXISTS videos_unique_playlist_video;

-- videos: deduplicate before adding unique constraint
-- Step 1: Update video_analyses to point to the video we'll keep (oldest per user+youtube_video_id)
UPDATE public.video_analyses va
SET video_id = kept.id
FROM public.videos v
JOIN (
  SELECT DISTINCT ON (user_id, youtube_video_id) id, user_id, youtube_video_id
  FROM public.videos
  ORDER BY user_id, youtube_video_id, created_at ASC
) kept ON v.user_id = kept.user_id AND v.youtube_video_id = kept.youtube_video_id
WHERE va.video_id = v.id
  AND v.id != kept.id;

-- Step 2: Delete duplicate videos (keep the oldest per user+youtube_video_id)
DELETE FROM public.videos
WHERE id NOT IN (
  SELECT DISTINCT ON (user_id, youtube_video_id) id
  FROM public.videos
  ORDER BY user_id, youtube_video_id, created_at ASC
);

ALTER TABLE public.videos
  ADD CONSTRAINT videos_unique_user_video UNIQUE (user_id, youtube_video_id);

-- video_analyses: remove playlist_id binding
ALTER TABLE public.video_analyses
  DROP CONSTRAINT IF EXISTS video_analyses_playlist_id_fkey;

ALTER TABLE public.video_analyses
  DROP COLUMN IF EXISTS playlist_id;

-- RLS: videos (user-owned)

CREATE POLICY "Users can view their videos"
  ON public.videos FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their videos"
  ON public.videos FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their videos"
  ON public.videos FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their videos"
  ON public.videos FOR DELETE
  USING (auth.uid() = user_id);

-- RLS: video_analyses (validate against videos ownership)
DROP POLICY IF EXISTS "Users can view their video analyses" ON public.video_analyses;
DROP POLICY IF EXISTS "Users can insert their video analyses" ON public.video_analyses;
DROP POLICY IF EXISTS "Users can update their video analyses" ON public.video_analyses;
DROP POLICY IF EXISTS "Users can delete their video analyses" ON public.video_analyses;

CREATE POLICY "Users can view their video analyses"
  ON public.video_analyses FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.videos
      WHERE videos.id = video_analyses.video_id
        AND videos.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert their video analyses"
  ON public.video_analyses FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.videos
      WHERE videos.id = video_analyses.video_id
        AND videos.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update their video analyses"
  ON public.video_analyses FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.videos
      WHERE videos.id = video_analyses.video_id
        AND videos.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.videos
      WHERE videos.id = video_analyses.video_id
        AND videos.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete their video analyses"
  ON public.video_analyses FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM public.videos
      WHERE videos.id = video_analyses.video_id
        AND videos.user_id = auth.uid()
    )
  );
