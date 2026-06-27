# YouChannel Service

YouChannel Service is the backend workspace for async video analysis and
operations tooling.

- `apps/jobs`: Fastify HTTP API, pg-boss queue, analysis workers, admin API,
  and static hosting for the built admin console.
- `apps/admin`: React/Vite admin console.
- `packages/core`: shared TypeScript types.
- `supabase/migrations`: backend-focused migration copy. For a full product
  database, use `../youchannel/supabase/migrations` as the canonical schema.

## Prerequisites

- Node.js 20+.
- pnpm 9.12+.
- A Supabase project with the YouChannel schema applied.
- Direct Postgres `DATABASE_URL` for the same Supabase database.
- Supabase service role key.
- Gemini API key for analysis workers.

## Local Development

1. Start/apply the complete Supabase schema from the user app repository.

   ```bash
   cd ../youchannel
   supabase start
   supabase db reset
   supabase status
   ```

2. Install service dependencies.

   ```bash
   cd ../youchannel-service
   pnpm install
   ```

3. Create environment files.

   ```bash
   cp apps/jobs/.env.example apps/jobs/.env
   cp apps/admin/.env.example apps/admin/.env
   ```

4. Fill `apps/jobs/.env`.

   Required values:

   - `DATABASE_URL`: Postgres connection string from `supabase status` or your
     hosted Supabase project.
   - `SUPABASE_URL`: Supabase API URL.
   - `SUPABASE_SERVICE_ROLE_KEY`: service role key.
   - `OPENAPI_SHARED_KEY`: shared secret for `POST /openapi/analysis`.
   - `GEMINI_API_KEY`: Gemini key used by workers.

5. Fill `apps/admin/.env`.

   Required values:

   - `VITE_SUPABASE_URL`: Supabase API URL.
   - `VITE_SUPABASE_ANON_KEY`: Supabase anon key.
   - `VITE_JOBS_API_URL=http://localhost:4000` for local dev.

6. Start both apps.

   ```bash
   pnpm -C apps/jobs dev
   pnpm -C apps/admin dev
   ```

Local URLs:

- Jobs API: `http://localhost:4000`
- Health check: `http://localhost:4000/health`
- Admin console: `http://localhost:5173`

You can also run everything with one command:

```bash
pnpm dev
```

## Admin Bootstrap

The admin console uses Supabase Auth for login. API requests are accepted only
when the authenticated user exists in `public.admin_users`.

For the first admin, create or confirm a Supabase Auth user, then run:

```sql
insert into public.admin_users (user_id)
select id from auth.users
where email = 'admin@your-domain.example'
on conflict (user_id) do nothing;
```

See `ADMIN_SETUP.md` for the full setup and recovery guide.

## OpenAPI Analysis Endpoint

`POST /openapi/analysis` accepts a service key in any of these forms:

- `x-openapi-key: <OPENAPI_SHARED_KEY>`
- `x-api-key: <OPENAPI_SHARED_KEY>`
- `x-service-key: <OPENAPI_SHARED_KEY>`
- `Authorization: Bearer <OPENAPI_SHARED_KEY>`

The current request body inserts one or more YouTube videos for a user and then
queues analysis jobs:

```json
{
  "userId": "00000000-0000-4000-8000-000000000000",
  "videos": [
    {
      "youtubeVideoId": "dQw4w9WgXcQ",
      "title": "Example video",
      "description": "Video description",
      "thumbnailUrl": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      "publishedAt": "2026-01-01T00:00:00Z",
      "duration": "PT3M33S",
      "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "raw": {}
    }
  ]
}
```

## Production Deployment On Fly.io

1. Create the app if needed.

   ```bash
   fly apps create youchannel-service
   ```

2. Set runtime secrets.

   ```bash
   fly secrets set \
     DATABASE_URL='<supabase postgres url>' \
     SUPABASE_URL='https://<project-ref>.supabase.co' \
     SUPABASE_SERVICE_ROLE_KEY='<supabase service role key>' \
     OPENAPI_SHARED_KEY='<shared key>' \
     GEMINI_API_KEY='<gemini key>' \
     GEMINI_MODEL='gemini-2.5-flash' \
     ADMIN_ORIGIN='https://<your-service-domain>'
   ```

   If the database password contains symbols such as `@`, `#`, `/`, or `:`,
   URL-encode it in `DATABASE_URL`.

3. Deploy with admin client build args.

   ```bash
   fly deploy \
     --build-arg VITE_SUPABASE_URL=https://<project-ref>.supabase.co \
     --build-arg VITE_SUPABASE_ANON_KEY=<supabase anon key>
   ```

The production container serves the built admin console from the jobs service,
so the admin UI and jobs API share the same origin.

## Useful Commands

```bash
pnpm build           # build core, jobs, and admin
pnpm typecheck       # typecheck all workspaces
pnpm preview:jobs    # build and run jobs locally
pnpm preview:admin   # build and preview admin locally
```

## More Docs

- `ADMIN_SETUP.md`: admin user setup and recovery.
- `docs/BUSINESS_LOGIC.md`: jobs queue and analysis flow.
- `docs/quota/QUOTA_DESIGN.md`: quota schema and consumption design.
- `docs/quota/QUOTA_ADMIN.md`: quota operations guide.
