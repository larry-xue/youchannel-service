# YouChannel Service - AI Agent Guide

## Build/Development Commands

### Package Manager
- **Tool**: pnpm (workspace monorepo)
- **Install**: `pnpm install`
- **Add dependency**: `pnpm --filter <package> add <dep>`

### Common Commands
```bash
# Development (run all services)
pnpm dev                  # Parallel dev for all packages
pnpm -C apps/jobs dev     # Jobs service only
pnpm -C apps/admin dev    # Admin panel only

# Type Checking
pnpm typecheck            # Check all packages
pnpm -C apps/jobs typecheck
pnpm -C apps/admin typecheck

# Building
pnpm build                # Build all packages
pnpm -C apps/jobs build   # Build jobs (tsc)
pnpm -C apps/admin build  # Build admin (vite)

# Linting
pnpm lint                 # Currently no-op (no linter configured)
```

### Running Tests
⚠️ **No test framework is currently configured.**
- There are no test files or test commands in the repository
- If adding tests, consider installing `vitest` (works well with Vite and TypeScript)
- Example single test command (after setup): `pnpm -C apps/jobs test -- JobWorker.spec.ts`

### Path Alias Resolution for Runtime
**Important**: TypeScript path aliases are resolved at build time using `tsc-alias`.

- **Dev mode** (`tsx watch`): Path aliases work automatically via `tsx`
- **Production build**: `tsc` compiles TypeScript, then `tsc-alias` converts aliases to relative paths with `.js` extensions
- **Build configuration**: See `tsconfig.build.json` in each package for `tsc-alias` settings

## Code Style Guidelines

### File & Module Format
- **TypeScript** with strict mode enabled
- **ESM** only - use `import`/`export`
- **Import Paths**: Use path aliases for internal imports (no file extensions):
  - `apps/jobs`: `@jobs/*` → `src/*`
  - `apps/admin`: `@/*` → `src/*`
  - `packages/core`: `@core/*` → `src/*`
- **Built-ins**: Use `node:` prefix: `import { join } from 'node:path'`

### Naming Conventions
- **Files**: kebab-case: `job-worker.ts`, `database-connection.ts`
- **Classes/Types**: PascalCase: `JobRunner`, `DbConfig`
- **Functions/Variables**: camelCase: `getJobs`, `dbConnection`
- **Constants**: UPPER_SNAKE_CASE: `MAX_RETRIES`, `DATABASE_URL`

### Formatting
- **Indentation**: 2 spaces (no tabs)
- **Quotes**: Double quotes for strings: `"hello"`
- **Semicolons**: Always required
- **Trailing commas**: Required in multi-line arrays/objects
- **Max line length**: 100 characters

### Import Ordering
1. Node.js built-ins (with `node:` prefix)
2. External dependencies
3. Internal workspace dependencies (`@youchannel/core`)
4. Internal module aliases (`@jobs/*`, `@/*`, `@core/*`)
5. Relative imports (only for same-directory files)

```typescript
import { readFile } from 'node:fs';
import fastify from 'fastify';
import { JobType } from '@youchannel/core';
import { config } from '@jobs/config';
import { logger } from '@jobs/logger';
```

### TypeScript Rules
- Enable strict mode (already configured in `tsconfig.base.json`)
- Use `unknown` instead of `any` for untyped data
- Prefer `interface` for object shapes, `type` for unions/primitives
- Use explicit return types for public API functions

### Error Handling
- **Backend**: Use `logger.error()` with error objects: `logger.error({ err }, 'Job failed')`
- **Async**: Always use `try/catch` with top-level error logging
- **Fastify**: Errors should be thrown, Fastify will handle HTTP responses
- **React**: Error boundaries for component trees

### Component Patterns (apps/admin)
- Use functional components with hooks
- Radix UI primitives with `@radix-ui/*`
- Tailwind CSS for styling (no CSS modules)
- TanStack Query for server state
- TanStack Router for navigation

### Backend Patterns (apps/jobs)
- Fastify for HTTP server
- pg-boss for job queue
- Direct pg pool for database queries
- Supabase client for service-level operations
- Zod for runtime validation

## Architecture Notes

### Package Responsibilities
- **@youchannel/core**: Shared types, database SQL, common utilities
- **@youchannel/jobs**: Fastify API, pg-boss workers, background processing
- **@youchannel/admin**: React admin dashboard, Vite frontend

### Database (Supabase)
- Migrations in `supabase/migrations/`
- Use service role key in backend (`SUPABASE_SERVICE_KEY`)
- Use anon/client key in frontend with RLS policies
- RLS policies enforce data isolation (see `README.md`)

### Environment Variables
- Load from `.env` files using `dotenv`
- Jobs app: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
- Admin app: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`

### Git Conventions
- Follow conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`
- Always run `pnpm typecheck` before committing
- Ensure no secrets committed (check .gitignore)
