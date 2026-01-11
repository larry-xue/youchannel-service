create table public.learning_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  target_language text not null default 'en-US',
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  constraint learning_profiles_user_id_key unique(user_id)
);

alter table public.learning_profiles enable row level security;

create policy "Users can view their own profile"
  on public.learning_profiles for select
  using (auth.uid() = user_id);

create policy "Users can insert their own profile"
  on public.learning_profiles for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own profile"
  on public.learning_profiles for update
  using (auth.uid() = user_id);

create trigger set_learning_profiles_updated_at
  before update on public.learning_profiles
  for each row execute function public.set_updated_at();
