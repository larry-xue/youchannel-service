# 使用 Node.js 20 LTS 作为基础镜像
FROM node:20-alpine AS base

# 安装 pnpm
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# 设置工作目录
WORKDIR /app

# 复制 package 文件（用于依赖安装）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY apps/jobs/package.json ./apps/jobs/
COPY apps/admin/package.json ./apps/admin/

# 安装所有依赖（包括 devDependencies，用于构建）
RUN pnpm install --frozen-lockfile

# 复制源代码
COPY packages/core ./packages/core
COPY apps/jobs ./apps/jobs
COPY apps/admin ./apps/admin
COPY tsconfig.base.json ./

# 构建项目（包括前端和后端）
RUN pnpm build

# 生产阶段
FROM node:20-alpine AS production

# 安装 pnpm
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

# 复制 workspace 配置文件
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# 复制 package.json 文件（用于依赖解析）
COPY packages/core/package.json ./packages/core/
COPY apps/jobs/package.json ./apps/jobs/

# 安装生产依赖（不包含 devDependencies）
RUN pnpm install --frozen-lockfile --prod

# 复制构建产物
COPY --from=base /app/packages/core/dist ./packages/core/dist
COPY --from=base /app/apps/jobs/dist ./apps/jobs/dist
COPY --from=base /app/apps/admin/dist ./apps/admin/dist

# 设置工作目录到 jobs 应用
WORKDIR /app/apps/jobs

# 暴露端口
EXPOSE 4000

# 启动应用
CMD ["node", "dist/index.js"]
