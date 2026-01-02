# Jobs 服务业务逻辑文档

## 系统概述

Jobs 服务是一个基于 `pg-boss` 的异步任务处理系统，主要负责：
1. 定期同步 YouTube 播放列表数据
2. 管理视频同步状态
3. 触发视频分析任务
4. 提供管理后台 API

## 核心组件

### 1. 任务队列系统

使用 `pg-boss` 作为任务队列引擎，基于 PostgreSQL 实现分布式任务调度。

**主要队列：**
- `kickoff`: 触发同步任务的调度队列
- `sync.playlist`: 播放列表同步任务队列
- `analyze.video`: 视频分析任务队列（由本服务入队，实际处理在其他服务中）

### 2. 数据库连接

- **PostgreSQL**: 主数据库，存储业务数据和任务状态
- **Supabase**: 用于用户认证和管理

## 核心业务流程

### 流程 1: Kickoff 任务（定时触发同步）

**触发方式：**
1. **定时触发**：通过 Cron 表达式（`KICKOFF_CRON`）定期执行

**执行流程：**

```
1. 创建 SyncRun 记录
   - 状态: queued → running
   - 记录触发来源（schedule）和请求者

2. 查询需要同步的播放列表
   - 查询条件：
     * entry_status = 'active'
     * next_sync_at IS NULL 或 next_sync_at <= now()
   - 使用 FOR UPDATE SKIP LOCKED 避免并发冲突
   - 按 next_sync_at 升序排序，优先处理最久未同步的
   - 限制数量：KICKOFF_BATCH_LIMIT（默认 50）

3. 为每个播放列表创建 JobRun 和 pg-boss 任务
   - 创建 JobRun 记录（状态: queued）
   - 发送 sync.playlist 任务到 pg-boss
   - 使用 singletonKey 防止重复任务（格式: `playlist.{playlistId}`）
   - 如果任务已存在（deduped），标记 JobRun 为 skipped

4. 更新 SyncRun 状态
   - 成功：status = succeeded，记录 enqueued/skipped 数量
   - 失败：status = failed，记录错误信息
```

**关键配置：**
- `KICKOFF_BATCH_LIMIT`: 每次处理的最大播放列表数量（默认 50）
- `SYNC_INTERVAL_SEC`: 默认同步间隔（默认 3600 秒）

### 流程 2: Sync Playlist 任务（播放列表同步）

**任务参数：**
```typescript
{
  syncRunId: string;      // 所属的同步运行 ID
  playlistId: string;     // 播放列表 ID
  userId?: string;        // 用户 ID
  jobRunId: string;       // JobRun 记录 ID
}
```

**执行流程：**

```
1. 更新 JobRun 状态
   - status: queued → running
   - 记录 startedAt 和 attempt（重试次数）

2. 验证播放列表
   - 查询播放列表信息和关联的 YouTube 账号
   - 检查项：
     * 播放列表是否存在 → 不存在：标记为 skipped (playlist_missing)
     * entry_status 是否为 'active' → 否：标记为 skipped (playlist_inactive)
     * access_token 和 refresh_token 同时缺失 → skipped (auth_missing)，不更新 entry_status
     * access_token 过期（expires_at）→ 使用 refresh_token 刷新并更新 youtube_accounts

3. 从 YouTube API 获取数据
   a. 获取播放列表项（fetchPlaylistItems）
      - 分页获取所有视频项
      - 返回：items[] 和 etag
   
   b. 获取视频详情（fetchVideoDetails）
      - 批量获取视频时长等信息（每批 50 个）
      - 返回：Map<videoId, VideoItem>

4. 处理视频数据
   a. 去重处理
      - 使用 Map 去重（基于 videoId）
      - 提取所有唯一的 videoId
   
   b. 查询现有视频状态
      - 查询数据库中已存在的视频及其 sync_status
      - 识别新视频（不存在或状态不是 'synced'）
   
   c. 批量更新/插入视频（upsertVideos）
      - 每批处理 100 个视频（VIDEO_UPSERT_CHUNK_SIZE）
      - 使用 ON CONFLICT 进行 upsert
      - 更新字段：
        * title, description, published_at
        * thumbnail_url（优先选择 maxres > standard > high > medium > default）
        * duration, raw（原始 API 响应）
        * sync_status = 'synced'
        * removed_at = null
        * last_seen_at = 当前时间
      - 返回：Map<youtubeVideoId, videoId>
   
   d. 标记已移除的视频（markRemovedVideos）
      - 将不在当前播放列表中的视频标记为 removed
      - 条件：sync_status = 'synced' 且 youtube_video_id 不在当前列表中
      - 更新：sync_status = 'removed', removed_at = 当前时间
   
   e. 更新播放列表最后同步时间
      - 更新 playlists.last_synced_at

5. 分析任务入队（手动触发）
   - 同步流程不再自动触发分析
   - 由 OpenAPI 或后台管理员接口手动触发（见流程 3）

6. 更新 JobRun 状态
   - 成功：status = succeeded
   - 记录结果：
     * fetchedCount: 获取的视频数量
     * newCount: 新视频数量
     * removedCount: 移除的视频数量
     * durationMs: 执行耗时
     * analysesEnqueued: 入队的分析任务数
     * analysesSkipped: 跳过的分析任务数
     * analysisSkipReasons: 跳过原因统计
```

**错误处理：**

| HTTP 状态码 | 处理方式 |
|------------|---------|
| 404 | 标记播放列表为 `lost`，JobRun 状态为 `skipped` |
| 401/403 | 标记播放列表为 `auth_invalid`，JobRun 状态为 `skipped` |
| 429/5xx | JobRun 状态为 `failed`，触发重试（最多 5 次） |
| 其他 | JobRun 状态为 `failed`，不重试 |

**重试策略：**
- 最大重试次数：5 次（SYNC_RETRY_LIMIT）
- 初始延迟：60 秒（SYNC_RETRY_DELAY_SEC）
- 最大延迟：600 秒（SYNC_RETRY_DELAY_MAX_SEC）
- 使用指数退避（retryBackoff: true）

### 流程 3: 视频分析任务入队（enqueueAnalyses）

**注意**：本服务只负责将分析任务入队到 `analyze.video` 队列，实际的分析处理由其他服务完成。

**触发时机：**
- OpenAPI 或后台管理员接口手动触发

**处理逻辑：**

```
1. 筛选候选视频
   - 过滤时长超过 3600 秒的视频
   - 计算提示词哈希（SHA256）

2. 检查已存在的分析
   - 查询 video_analyses 表
   - 过滤已存在相同 videoId + promptHash 的记录

3. 检查用户配额
   - 查询 user_quotas 表
   - 计算剩余配额：max_analyses - analysis_count
   - 只入队剩余配额范围内的视频

4. 发送分析任务
   - 队列：analyze.video
   - 单例键：analysis.{videoId}.{promptHash}
   - 更新配额计数

5. 返回统计结果
   - enqueued: 成功入队的数量
   - skipped: 跳过的数量
   - skipReasons: 跳过原因统计
```

## 数据库表结构

### 核心表

1. **playlists**
   - 存储播放列表配置
   - 关键字段：`entry_status`, `next_sync_at`, `last_synced_at`, `sync_interval_sec`, `analysis_prompt`

2. **videos**
   - 存储视频数据
   - 关键字段：`sync_status` (synced/removed), `last_seen_at`, `removed_at`
   - 唯一约束：`(playlist_id, youtube_video_id)`

3. **video_analyses**
   - 存储视频分析记录
   - 用于去重：`(video_id, prompt_hash)`

4. **user_quotas**
   - 用户分析配额管理
   - 字段：`analysis_count`, `max_analyses`

5. **sync_runs**
   - 同步运行记录
   - 状态：queued → running → succeeded/failed

6. **job_runs**
   - 单个任务运行记录
   - 状态：queued → running → succeeded/failed/skipped
   - 关联：sync_run_id, playlist_id, user_id

7. **youtube_accounts**
   - YouTube 账号认证信息
   - 关键字段：`access_token`, `refresh_token`

## 管理后台 API

### 认证
- 使用 Supabase Auth 进行身份验证
- 请求头：`Authorization: Bearer <token>`
- 验证流程：
  1. 从 Authorization 头提取 token
  2. 使用 Supabase 验证 token 并获取用户信息
  3. 查询 `admin_users` 表确认用户是否为管理员
  4. 验证失败返回 401（missing_token/invalid_token）或 403（not_admin）
- 认证成功后，用户信息存储在 `request.adminUser` 中

### 主要接口

1. **GET /admin/sync-runs**
   - 查询同步运行记录列表
   - 参数：limit（默认 50）

2. **GET /admin/sync-runs/:id/job-runs**
   - 查询指定同步运行的 JobRun 列表
   - 参数：limit（默认 50）

3. **POST /admin/job-runs/:id/retry**
   - 重试指定的 JobRun
   - 返回：bossJobId 或错误（deduped/not_found/missing_playlist）

4. **POST /admin/analysis**
   - 管理员触发分析任务入队
   - 参数：playlistId（必填）, userId（可选）, videoIds（可选）, limit（可选）
   - 返回：enqueued/skipped/skipReasons

5. **GET /admin/videos**
   - 管理员查询视频列表
   - 参数：userId（可选）, syncStatus（可选）, limit（可选）, offset（可选）
   - 返回：视频列表 + 最新分析信息

6. **GET /admin/users**
   - 查询管理员用户列表

7. **POST /admin/users**
   - 添加管理员用户
   - 参数：email, password（可选）, createIfNotExists（可选）

8. **DELETE /admin/users/:userId**
   - 删除管理员用户（不能删除自己）

9. **GET /admin/system-users**
   - 查询系统所有用户及其 YouTube 账号信息

### OpenAPI 接口
- 鉴权：共享密钥（`OPENAPI_SHARED_KEY`），可通过 `x-openapi-key` 或 `Authorization: Bearer <key>` 传递
- acting user：由请求体中的 userId 指定，服务端会做资源归属校验

1. **POST /openapi/analysis**
   - 触发分析任务入队
   - 参数：userId（必填）, playlistId（必填）, videoIds（可选）, limit（可选）
   - 校验：playlist/video 必须归属 userId
   - 返回：enqueued/skipped/skipReasons

### 静态文件服务
- 提供 admin 前端的静态文件服务
- SPA 路由回退：非 API 路由返回 index.html

## 配置项

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `PORT` | 服务端口 | 4000 |
| `DATABASE_URL` | PostgreSQL 连接字符串 | 必填 |
| `SUPABASE_URL` | Supabase 项目 URL | 必填 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 服务角色密钥 | 必填 |
| `ADMIN_ORIGIN` | 管理后台允许的源 | http://localhost:5173 |
| `OPENAPI_SHARED_KEY` | OpenAPI 共享密钥 | 必填 |
| `KICKOFF_CRON` | 定时触发 Cron 表达式 | 可选 |
| `KICKOFF_BATCH_LIMIT` | 每次处理的最大播放列表数 | 50 |
| `SYNC_INTERVAL_SEC` | 默认同步间隔（秒） | 3600 |
| `LOG_LEVEL` | 日志级别 | info |
| `SENTRY_DSN` | Sentry DSN（可选） | - |
| `SENTRY_ENV` | Sentry 环境（可选） | - |

## 关键常量

- `ANALYSIS_MAX_DURATION_SEC`: 3600（1 小时）- 视频分析的最大时长限制
- `VIDEO_UPSERT_CHUNK_SIZE`: 100 - 批量更新视频的批次大小
- `SYNC_RETRY_LIMIT`: 5 - 同步任务最大重试次数
- `SYNC_RETRY_DELAY_SEC`: 60 - 重试初始延迟（秒）
- `SYNC_RETRY_DELAY_MAX_SEC`: 600 - 重试最大延迟（秒）

## 数据同步策略

### 播放列表选择策略
1. 优先同步 `next_sync_at` 最早（或为 NULL）的播放列表
2. 使用 `FOR UPDATE SKIP LOCKED` 避免并发冲突
3. 同步后更新 `next_sync_at = now() + sync_interval_sec + jitter`
   - jitter: 随机延迟，避免所有播放列表同时同步
   - jitter 范围：`min(interval * 0.1, 300)` 秒

### 视频状态管理
- **synced**: 视频存在于播放列表中
- **removed**: 视频已从播放列表中移除
- 通过 `last_seen_at` 和 `removed_at` 跟踪视频状态变化

## 错误监控

- 集成 Sentry 进行错误追踪
- 关键错误点：
  - YouTube API 调用失败
  - 数据库操作异常
  - 任务处理异常

## 系统启动流程

```
1. 加载环境配置
2. 初始化 Logger
3. 初始化 Sentry（如果配置了 DSN）
4. 连接 PostgreSQL（pg-boss + 业务数据库）
5. 连接 Supabase
6. 启动 pg-boss
7. 注册 Worker（kickoff, sync.playlist）
8. 注册定时任务（如果配置了 KICKOFF_CRON）
9. 启动 HTTP 服务器（Fastify）
10. 监听关闭信号（SIGINT/SIGTERM）
```

## 注意事项

1. **任务去重**：使用 `singletonKey` 防止同一播放列表的重复同步任务
2. **并发控制**：使用数据库锁（FOR UPDATE SKIP LOCKED）避免并发冲突
3. **配额管理**：视频分析任务受用户配额限制
4. **错误恢复**：播放列表认证失败会自动更新状态，避免重复尝试
5. **数据一致性**：使用事务确保数据一致性（如 reservePlaylistsForSync）
