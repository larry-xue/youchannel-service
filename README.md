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
- Apply `packages/core/sql/schema.sql` to the Supabase project.
- RLS keeps `sync_runs` and `job_runs` service-role only; admin UI uses the jobs API.
