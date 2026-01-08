# YouChannel Service

Monorepo layout:
- apps/jobs: jobs service (Fastify + pg-boss)
- apps/admin: admin panel (React + Vite)
- packages/core: shared types + database SQL

Quick start:
1) pnpm install
2) Copy env files from `.env.example` in each app
3) pnpm -C apps/jobs dev
4) pnpm -C apps/admin dev

Database:
- Migrations are in `supabase/migrations/`. Apply them to your Supabase project.
- RLS keeps `sync_runs` and `job_runs` service-role only; admin UI uses the jobs API.
- Quota system uses `quota_grants` + `quota_usage_events` with RPCs (`consume_quota`, `refund_quota`) and cache refresh helpers; see `docs/QUOTA_DESIGN.md` and `docs/QUOTA_ADMIN.md`.
