-- Rename channels to playlists (safe for existing databases)
DO $$
BEGIN
  IF to_regclass('public.channels') IS NOT NULL THEN
    ALTER TABLE public.channels RENAME TO playlists;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'playlists'
      AND column_name = 'channel_id'
  ) THEN
    ALTER TABLE public.playlists RENAME COLUMN channel_id TO playlist_id;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'channels_unique_user_channel'
  ) THEN
    ALTER TABLE public.playlists
      RENAME CONSTRAINT channels_unique_user_channel TO playlists_unique_user_playlist;
  END IF;
END $$;

ALTER INDEX IF EXISTS channels_user_id_idx RENAME TO playlists_user_id_idx;
ALTER INDEX IF EXISTS channels_one_active_per_user RENAME TO playlists_one_active_per_user;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_channels_updated_at') THEN
    EXECUTE 'ALTER TRIGGER set_channels_updated_at ON public.playlists RENAME TO set_playlists_updated_at';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'playlists'
      AND policyname = 'Users can view their channels'
  ) THEN
    EXECUTE 'ALTER POLICY "Users can view their channels" ON public.playlists RENAME TO "Users can view their playlists"';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'playlists'
      AND policyname = 'Users can insert their channels'
  ) THEN
    EXECUTE 'ALTER POLICY "Users can insert their channels" ON public.playlists RENAME TO "Users can insert their playlists"';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'playlists'
      AND policyname = 'Users can update their channels'
  ) THEN
    EXECUTE 'ALTER POLICY "Users can update their channels" ON public.playlists RENAME TO "Users can update their playlists"';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'playlists'
      AND policyname = 'Users can delete their channels'
  ) THEN
    EXECUTE 'ALTER POLICY "Users can delete their channels" ON public.playlists RENAME TO "Users can delete their playlists"';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'videos'
      AND column_name = 'channel_id'
  ) THEN
    ALTER TABLE public.videos RENAME COLUMN channel_id TO playlist_id;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'videos_unique_channel_video'
  ) THEN
    ALTER TABLE public.videos
      RENAME CONSTRAINT videos_unique_channel_video TO videos_unique_playlist_video;
  END IF;
END $$;

ALTER INDEX IF EXISTS videos_channel_id_idx RENAME TO videos_playlist_id_idx;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'videos_channel_id_fkey'
  ) THEN
    ALTER TABLE public.videos
      RENAME CONSTRAINT videos_channel_id_fkey TO videos_playlist_id_fkey;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'video_analyses'
      AND column_name = 'channel_id'
  ) THEN
    ALTER TABLE public.video_analyses RENAME COLUMN channel_id TO playlist_id;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'video_analyses_channel_id_fkey'
  ) THEN
    ALTER TABLE public.video_analyses
      RENAME CONSTRAINT video_analyses_channel_id_fkey TO video_analyses_playlist_id_fkey;
  END IF;
END $$;

DROP POLICY IF EXISTS "Users can view their videos" ON public.videos;
DROP POLICY IF EXISTS "Users can insert their videos" ON public.videos;
DROP POLICY IF EXISTS "Users can update their videos" ON public.videos;
DROP POLICY IF EXISTS "Users can delete their videos" ON public.videos;

CREATE POLICY "Users can view their videos"
  ON public.videos FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.playlists
      WHERE playlists.id = videos.playlist_id
        AND playlists.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert their videos"
  ON public.videos FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.playlists
      WHERE playlists.id = videos.playlist_id
        AND playlists.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update their videos"
  ON public.videos FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.playlists
      WHERE playlists.id = videos.playlist_id
        AND playlists.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.playlists
      WHERE playlists.id = videos.playlist_id
        AND playlists.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete their videos"
  ON public.videos FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.playlists
      WHERE playlists.id = videos.playlist_id
        AND playlists.user_id = auth.uid()
    )
  );
