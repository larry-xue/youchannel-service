# Jobs 服务业务逻辑文档

## 系统概述

Jobs 服务是一个基于 `pg-boss` 的异步任务处理系统，主要负责：
1. 处理视频分析任务
2. 提供管理后台 API

## 核心组件

### 1. 任务队列系统

使用 `pg-boss` 作为任务队列引擎，基于 PostgreSQL 实现分布式任务调度。

**主要队列：**
- `analyze.video`: 视频分析任务队列

### 2. 数据库连接

- **PostgreSQL**: 主数据库，存储业务数据和任务状态
- **Supabase**: 用于用户认证和管理

## 核心业务流程

### 流程 1: 视频分析任务入队（enqueueAnalyses）

**触发时机：**
- OpenAPI 接口手动触发
- 后台管理员接口手动触发

**处理逻辑：**

```
1. 筛选候选视频
   - 管理员入口按 userId、可选 videoIds、limit 从 videos 读取候选视频
   - OpenAPI 入口先插入本次请求中的新视频，再把新插入的视频作为候选
   - 读取视频时长（用于配额校验）

2. 检查已存在的分析
   - 查询 video_analyses 表
   - 当前只跳过已有 pending 分析的视频，允许同一视频保留多次历史分析

3. 检查配额时长上限
   - 从 quota_grants 计算用户当前可用的 max_video_seconds（active + 有效期内 + remaining > 0）
   - 视频时长超过 max_video_seconds 时直接跳过（duration_exceeded）

4. 发送分析任务
   - 队列：analyze.video
   - 单例键：analysis.{analysisId}
   - 先插入一条新的 video_analyses pending 记录
   - pg-boss 选项：retryLimit、retryDelay、expireInSeconds

5. 返回统计结果
   - enqueued: 成功入队的数量
   - skipped: 跳过的数量
   - skipReasons: 跳过原因统计（duration_exceeded, already_pending, quota_exceeded）
```

### 流程 2: 视频分析任务处理（analyze.video worker）

**任务参数：**
```typescript
{
  videoId: string;
  userId: string;
  analysisId: string;
}
```

**执行流程：**

```
1. 验证视频
   - 查询视频信息
   - 检查视频是否存在
   - 验证视频归属 userId

2. 检查现有分析记录
   - 跳过已完成或正在处理的分析
   - pg-boss 自动处理超时任务（expireInSeconds）

3. 检查视频条件
   - 视频时长有效（> 0），否则跳过（duration_invalid）

4. 申请并扣减配额
   - 调用 consume_quota（video_seconds = durationSec）
   - idempotency_key = job.id
   - 不足则标记 quota_exceeded 并结束

5. 调用 Gemini API
   - 使用视频 URL 和内置结构化分析 prompt
   - 返回结构化 JSON 结果

6. 解析并保存结果
   - 验证输出格式
   - 保存到 video_analyses 表

7. 错误处理
   - 可重试错误（429/5xx/超时）：抛出异常触发 pg-boss 自动重试
   - 不可重试错误或重试用尽：标记为 failed，调用 refund_quota 退还配额
```

## 数据库表结构

### 核心表

1. **videos**
   - 存储视频数据
   - 关键字段：`user_id`, `youtube_video_id`, `title`, `description`, `thumbnail_url`, `published_at`, `duration`, `url`, `raw`, `removed_at`
   - 唯一约束：`(user_id, youtube_video_id)`

2. **video_analyses**
   - 存储视频分析记录
   - 同一视频允许保留多条分析历史
   - 入队时插入 `pending` 记录，worker 完成后更新为 `completed`、`failed` 或 `skipped`

3. **quota_grants**
   - 配额授予（订阅/套餐/手动/促销）
   - 关键字段：`video_seconds_total`, `video_seconds_remaining`, `chat_seconds_total`, `chat_seconds_remaining`, `max_video_seconds`, `valid_from`, `valid_to`, `status`

4. **quota_usage_events**
   - 配额流水事件（consume/refund/adjust）
   - 关键字段：`video_seconds_delta`, `chat_seconds_delta`, `idempotency_key`, `context`

5. **quota_usage_splits**
   - 事件按 grant 拆分的明细行（与 grant/user 关联）

6. **user_quotas**
   - 配额缓存（非真源）
   - 字段：`video_seconds_total`, `video_seconds_remaining`, `chat_seconds_total`, `chat_seconds_remaining`, `max_video_seconds`, `period_start_at`, `period_end_at`

7. **youtube_accounts**
   - YouTube 账号认证信息

8. **admin_users**
   - 管理后台授权表
   - API 会先校验 Supabase Auth token，再确认用户存在于该表

## 管理后台 API

### 认证
- 使用 Supabase Auth 进行身份验证
- 请求头：`Authorization: Bearer <token>`
- 验证流程：
  1. 从 Authorization 头提取 token
  2. 使用 Supabase 验证 token 并获取用户信息
  3. 查询 `admin_users` 表确认用户是否为管理员
  4. 验证失败返回 401（missing_token/invalid_token）或 403（not_admin）

### 主要接口

1. **POST /admin/analysis**
   - 管理员触发分析任务入队
   - 参数：`userId`（必填）, `videoIds`（可选）, `limit`（可选）
   - 返回：`userId`, `candidateCount`, `enqueued`, `skipped`, `skipReasons`

2. **GET /admin/videos**
   - 管理员查询视频列表
   - 参数：`userId`（可选）, `limit`（可选）, `offset`（可选）
   - 返回：视频列表 + 最新分析信息

3. **GET /admin/users**
   - 查询管理员用户列表

4. **POST /admin/users**
   - 添加管理员用户
   - 参数：email, password（可选）, createIfNotExists（可选）

5. **DELETE /admin/users/:userId**
   - 删除管理员用户（不能删除自己）

6. **GET /admin/system-users**
   - 查询系统所有用户及其 YouTube 账号信息

7. **GET /admin/jobs**
   - 查询任务/分析运行状态

8. **DELETE /admin/analyses/:analysisId**
   - 删除指定分析记录

### OpenAPI 接口
- 鉴权：共享密钥（`OPENAPI_SHARED_KEY`），可通过 `x-openapi-key`、`x-api-key`、`x-service-key` 或 `Authorization: Bearer <key>` 传递
- acting user：由请求体中的 `userId` 指定
- 当前接口会先按 `youtubeVideoId` 去重并插入 `videos`，再只对本次新插入的视频触发分析队列

1. **POST /openapi/analysis**
   - 触发分析任务入队
   - 参数：`userId`（必填）, `videos`（必填，非空数组）
   - `videos[]` 字段：`youtubeVideoId`, `title`, `description`, `thumbnailUrl`, `publishedAt`, `duration`, `url`, `raw`
   - 校验：视频元数据完整、`publishedAt` 是合法时间、`duration` 是正数 ISO 8601 YouTube 时长
   - 返回：`requestedCount`, `uniqueCount`, `insertedCount`, `existingCount`, `enqueued`, `skipped`, `skipReasons`

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
| `LOG_LEVEL` | 日志级别 | info |
| `SENTRY_DSN` | Sentry DSN（可选） | - |
| `SENTRY_ENV` | Sentry 环境（可选） | - |
| `GEMINI_API_KEY` | Gemini API Key（用于分析） | - |
| `GEMINI_MODEL` | Gemini 模型名称 | gemini-1.5-flash |

## 关键限制与常量

- `max_video_seconds`（来自 `quota_grants`）：单条视频可消费的最大时长限制（入队筛选 + consume_quota 校验）
- pg-boss 任务配置（见下方配置项表）

### pg-boss 任务配置

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `ANALYSIS_JOB_RETRY_LIMIT` | 任务最大重试次数 | 3 |
| `ANALYSIS_JOB_EXPIRE_SECONDS` | 任务超时时间（秒） | 900 |
| `ANALYSIS_JOB_RETRY_DELAY_SECONDS` | 重试延迟时间（秒） | 300 |

## 错误监控

- 集成 Sentry 进行错误追踪
- 关键错误点：
  - Gemini API 调用失败
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
7. 注册 Worker（analyze.video）
8. 启动 HTTP 服务器（Fastify）
9. 监听关闭信号（SIGINT/SIGTERM）
```

## 注意事项

1. **任务去重**：使用 `singletonKey` 防止同一视频的重复分析任务
2. **配额管理**：入队按 max_video_seconds 过滤，实际扣减在 worker 中调用 consume_quota
3. **错误恢复**：分析失败或不可用时调用 refund_quota 退还配额
