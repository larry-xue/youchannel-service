# Base image
FROM node:20-alpine AS base

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

# Copy workspace manifests for dependency install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY apps/jobs/package.json ./apps/jobs/
COPY apps/admin/package.json ./apps/admin/

# Install all deps (including dev) for build
RUN pnpm install

# Copy source
COPY packages/core ./packages/core
COPY apps/jobs ./apps/jobs
COPY apps/admin ./apps/admin
COPY tsconfig.base.json ./

ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY

ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

# Build workspace (frontend + backend)
RUN pnpm build

# Production stage
FROM node:20-alpine AS production

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

# Copy workspace manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY apps/jobs/package.json ./apps/jobs/

# Install production deps only
RUN pnpm install --prod

# Copy build outputs
COPY --from=base /app/packages/core/dist ./packages/core/dist
COPY --from=base /app/apps/jobs/dist ./apps/jobs/dist
COPY --from=base /app/apps/admin/dist ./apps/admin/dist

# Set workdir for jobs app
WORKDIR /app/apps/jobs

EXPOSE 4000

CMD ["node", "dist/index.js"]
