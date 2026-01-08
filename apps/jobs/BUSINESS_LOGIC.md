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

### 流程 2: 视频分析任务处理（analyze.video worker）

**任务参数：**
```typescript
{
  videoId: string;
  playlistId: string;
  userId: string;
  prompt: string;
  promptHash: string;
}
```

**执行流程：**

```
1. 验证视频
   - 查询视频信息
   - 检查视频是否存在
   - 验证 playlistId 和 userId 匹配

2. 检查现有分析记录
   - 跳过已完成或正在处理的分析
   - 回收超时的处理中状态（15分钟）

3. 检查视频条件
   - 视频时长不超过 3600 秒
   - 视频 sync_status 为 'synced'

4. 调用 Gemini API
   - 使用视频 URL 和分析 prompt
   - 返回结构化 JSON 结果

5. 解析并保存结果
   - 验证输出格式
   - 保存到 video_analyses 表

6. 错误处理
   - 可重试错误（429/5xx/超时）：抛出异常触发重试
   - 不可重试错误：标记为 failed，退还配额
```

## 数据库表结构

### 核心表

1. **playlists**
   - 存储播放列表配置
   - 关键字段：`entry_status`, `analysis_prompt`

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

5. **youtube_accounts**
   - YouTube 账号认证信息

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
   - 参数：playlistId（必填）, userId（可选）, videoIds（可选）, limit（可选）
   - 返回：enqueued/skipped/skipReasons

2. **GET /admin/videos**
   - 管理员查询视频列表
   - 参数：userId（可选）, syncStatus（可选）, limit（可选）, offset（可选）
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
| `LOG_LEVEL` | 日志级别 | info |
| `SENTRY_DSN` | Sentry DSN（可选） | - |
| `SENTRY_ENV` | Sentry 环境（可选） | - |
| `GEMINI_API_KEY` | Gemini API Key（用于分析） | - |
| `GEMINI_MODEL` | Gemini 模型名称 | gemini-1.5-flash |

## 关键常量

- `ANALYSIS_MAX_DURATION_SEC`: 3600（1 小时）- 视频分析的最大时长限制
- `ANALYSIS_PROCESSING_TIMEOUT_MS`: 15 分钟 - 处理超时时间

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
2. **配额管理**：视频分析任务受用户配额限制
3. **错误恢复**：分析失败会退还配额
