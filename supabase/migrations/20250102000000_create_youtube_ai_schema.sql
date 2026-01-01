-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Remove template table
DROP TABLE IF EXISTS public.todos;

-- Shared updated_at trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = TIMEZONE('utc'::text, NOW());
  RETURN NEW;
END;
$$ language 'plpgsql';

-- OAuth state tracking for YouTube connect flow
CREATE TABLE public.youtube_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  state text NOT NULL UNIQUE,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.youtube_oauth_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their oauth states"
  ON public.youtube_oauth_states FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their oauth states"
  ON public.youtube_oauth_states FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their oauth states"
  ON public.youtube_oauth_states FOR DELETE
  USING (auth.uid() = user_id);

-- Connected YouTube accounts
CREATE TABLE public.youtube_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'google',
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  expires_at timestamp with time zone,
  scope text,
  token_type text,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX youtube_accounts_user_id_idx ON public.youtube_accounts (user_id);

ALTER TABLE public.youtube_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their youtube accounts"
  ON public.youtube_accounts FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their youtube accounts"
  ON public.youtube_accounts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their youtube accounts"
  ON public.youtube_accounts FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their youtube accounts"
  ON public.youtube_accounts FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER set_youtube_accounts_updated_at
  BEFORE UPDATE ON public.youtube_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Playlists tracked per user
CREATE TABLE public.playlists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  youtube_account_id uuid REFERENCES public.youtube_accounts (id) ON DELETE SET NULL,
  playlist_id text NOT NULL,
  title text,
  description text,
  thumbnail_url text,
  custom_url text,
  is_active boolean NOT NULL DEFAULT false,
  analysis_prompt text NOT NULL DEFAULT 'Summarize the video in 5 bullet points and call out key insights.',
  last_synced_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT playlists_unique_user_playlist UNIQUE (user_id, playlist_id)
);

CREATE INDEX playlists_user_id_idx ON public.playlists (user_id);
CREATE UNIQUE INDEX playlists_one_active_per_user
  ON public.playlists (user_id)
  WHERE is_active;

ALTER TABLE public.playlists ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their playlists"
  ON public.playlists FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their playlists"
  ON public.playlists FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their playlists"
  ON public.playlists FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their playlists"
  ON public.playlists FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER set_playlists_updated_at
  BEFORE UPDATE ON public.playlists
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Videos fetched from YouTube
CREATE TABLE public.videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id uuid NOT NULL REFERENCES public.playlists (id) ON DELETE CASCADE,
  youtube_video_id text NOT NULL,
  title text,
  description text,
  published_at timestamp with time zone,
  thumbnail_url text,
  duration text,
  raw jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT videos_unique_playlist_video UNIQUE (playlist_id, youtube_video_id)
);

CREATE INDEX videos_playlist_id_idx ON public.videos (playlist_id);

ALTER TABLE public.videos ENABLE ROW LEVEL SECURITY;

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

CREATE TRIGGER set_videos_updated_at
  BEFORE UPDATE ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- AI analysis per video and prompt
CREATE TABLE public.video_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES public.videos (id) ON DELETE CASCADE,
  playlist_id uuid NOT NULL REFERENCES public.playlists (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  prompt text NOT NULL,
  prompt_hash text NOT NULL,
  analysis_text text NOT NULL,
  model text NOT NULL,
  usage jsonb,
  status text NOT NULL DEFAULT 'completed',
  error text,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT video_analyses_unique_prompt UNIQUE (video_id, prompt_hash)
);

CREATE INDEX video_analyses_video_id_idx ON public.video_analyses (video_id);
CREATE INDEX video_analyses_user_id_idx ON public.video_analyses (user_id);

ALTER TABLE public.video_analyses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their video analyses"
  ON public.video_analyses FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their video analyses"
  ON public.video_analyses FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their video analyses"
  ON public.video_analyses FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their video analyses"
  ON public.video_analyses FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER set_video_analyses_updated_at
  BEFORE UPDATE ON public.video_analyses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Conversations scoped to one or more videos
CREATE TABLE public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  playlist_id uuid REFERENCES public.playlists (id) ON DELETE SET NULL,
  title text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX conversations_user_id_idx ON public.conversations (user_id);

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their conversations"
  ON public.conversations FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their conversations"
  ON public.conversations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their conversations"
  ON public.conversations FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their conversations"
  ON public.conversations FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER set_conversations_updated_at
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Video selections per conversation
CREATE TABLE public.conversation_videos (
  conversation_id uuid NOT NULL REFERENCES public.conversations (id) ON DELETE CASCADE,
  video_id uuid NOT NULL REFERENCES public.videos (id) ON DELETE CASCADE,
  analysis_id uuid REFERENCES public.video_analyses (id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  PRIMARY KEY (conversation_id, video_id)
);

ALTER TABLE public.conversation_videos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their conversation videos"
  ON public.conversation_videos FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations
      WHERE conversations.id = conversation_videos.conversation_id
        AND conversations.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert their conversation videos"
  ON public.conversation_videos FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.conversations
      WHERE conversations.id = conversation_videos.conversation_id
        AND conversations.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update their conversation videos"
  ON public.conversation_videos FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations
      WHERE conversations.id = conversation_videos.conversation_id
        AND conversations.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.conversations
      WHERE conversations.id = conversation_videos.conversation_id
        AND conversations.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete their conversation videos"
  ON public.conversation_videos FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations
      WHERE conversations.id = conversation_videos.conversation_id
        AND conversations.user_id = auth.uid()
    )
  );

-- Conversation messages
CREATE TABLE public.conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations (id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL,
  metadata jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT conversation_messages_role_check CHECK (role IN ('user', 'assistant', 'system'))
);

CREATE INDEX conversation_messages_conversation_id_idx
  ON public.conversation_messages (conversation_id);

ALTER TABLE public.conversation_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their conversation messages"
  ON public.conversation_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations
      WHERE conversations.id = conversation_messages.conversation_id
        AND conversations.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert their conversation messages"
  ON public.conversation_messages FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.conversations
      WHERE conversations.id = conversation_messages.conversation_id
        AND conversations.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update their conversation messages"
  ON public.conversation_messages FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations
      WHERE conversations.id = conversation_messages.conversation_id
        AND conversations.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.conversations
      WHERE conversations.id = conversation_messages.conversation_id
        AND conversations.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete their conversation messages"
  ON public.conversation_messages FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations
      WHERE conversations.id = conversation_messages.conversation_id
        AND conversations.user_id = auth.uid()
    )
  );
