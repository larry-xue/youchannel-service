# 配额管理操作指南

本文档为支持和管理人员提供用户配额管理的操作流程。

## 前提条件

以下所有操作需要 **service_role** 权限或直接数据库访问权限。可通过 Supabase SQL 编辑器或特权数据库连接执行这些命令。

---

## 1. 为用户添加配额授权

使用此操作为用户授予额外配额（如促销赠送、问题补偿等）。

```sql
INSERT INTO public.quota_grants (
  user_id,
  source_type,
  source_ref,
  video_seconds_total,
  video_seconds_remaining,
  chat_seconds_total,
  chat_seconds_remaining,
  max_video_seconds,
  valid_from,
  valid_to,
  consume_priority
) VALUES (
  '用户UUID',                  -- 替换为实际用户 ID
  'manual',                   -- 可选: 'manual', 'promo', 'subscription', 'package'
  'support_ticket_12345',     -- 工单号，用于审计追踪
  3600,                       -- 视频秒数总量 (3600 = 1小时)
  3600,                       -- 视频秒数剩余 (新授权与总量相同)
  7200,                       -- 聊天秒数总量 (7200 = 2小时)
  7200,                       -- 聊天秒数剩余
  1800,                       -- 允许的最大单个视频时长 (1800 = 30分钟)
  now(),                      -- 生效时间: 立即生效
  NULL,                       -- 过期时间: NULL = 永不过期
  50                          -- 消费优先级: 数字越小越优先消费
);
```

### 常见场景

**小额促销赠送 (30分钟视频 + 1小时聊天):**
```sql
INSERT INTO public.quota_grants (
  user_id, source_type, source_ref,
  video_seconds_total, video_seconds_remaining,
  chat_seconds_total, chat_seconds_remaining,
  max_video_seconds, consume_priority
) VALUES (
  '用户UUID', 'promo', 'welcome_bonus',
  1800, 1800,   -- 30分钟视频
  3600, 3600,   -- 1小时聊天
  600,          -- 最大支持10分钟视频
  100           -- 优先级低于付费授权
);
```

**带过期时间的补偿授权:**
```sql
INSERT INTO public.quota_grants (
  user_id, source_type, source_ref,
  video_seconds_total, video_seconds_remaining,
  chat_seconds_total, chat_seconds_remaining,
  max_video_seconds, valid_to, consume_priority
) VALUES (
  '用户UUID', 'manual', 'compensation_issue_789',
  7200, 7200,                 -- 2小时视频
  14400, 14400,               -- 4小时聊天
  3600,                       -- 最大支持1小时视频
  now() + interval '30 days', -- 30天后过期
  25                          -- 高优先级，优先消费
);
```

---

## 2. 通过 RPC 发起退款

使用 `refund_quota` 函数撤销一个消费事件。配额将退还到**最初消费时使用的相同授权**。

```sql
SELECT refund_quota(
  '用户UUID',                            -- p_user_id
  '原始消费事件UUID',                     -- p_original_event_id
  'refund_' || gen_random_uuid()::text,  -- p_idempotency_key (唯一标识)
  '客服退款: 退款原因说明'                 -- p_reason
);
```

### 查找原始消费事件 ID

查询用户最近的消费事件：

```sql
SELECT id, event_type, video_seconds_delta, chat_seconds_delta, 
       reason, reference_id, created_at
FROM public.quota_usage_events
WHERE user_id = '用户UUID'
  AND event_type = 'consume'
ORDER BY created_at DESC
LIMIT 20;
```

### 防止重复退款

系统会自动阻止对同一事件的重复退款。尝试对同一原始事件退款两次将会失败并报错。

---

## 3. 撤销授权

阻止某个授权继续被使用（如欺诈、违规等情况）：

```sql
UPDATE public.quota_grants
SET status = 'revoked', updated_at = now()
WHERE id = '授权UUID';
```

> [!CAUTION]
> 撤销授权不会退还已消费的配额，只会阻止后续消费。

---

## 4. 审计查询

### 查看用户当前配额摘要

```sql
SELECT * FROM public.user_quotas WHERE user_id = '用户UUID';
```

### 查看用户的有效授权

```sql
SELECT id, source_type, source_ref,
       video_seconds_total, video_seconds_remaining,
       chat_seconds_total, chat_seconds_remaining,
       max_video_seconds, valid_from, valid_to, status
FROM public.quota_grants
WHERE user_id = '用户UUID'
  AND status = 'active'
  AND valid_from <= now()
  AND (valid_to IS NULL OR valid_to >= now())
ORDER BY consume_priority ASC, valid_to ASC NULLS LAST;
```

### 查看用户最近的使用记录

```sql
SELECT id, event_type, video_seconds_delta, chat_seconds_delta,
       reason, reference_type, reference_id, created_at
FROM public.quota_usage_events
WHERE user_id = '用户UUID'
ORDER BY created_at DESC
LIMIT 50;
```

### 查看某个事件的消费明细

```sql
SELECT s.id, s.grant_id, s.video_seconds_delta, s.chat_seconds_delta,
       g.source_type, g.source_ref
FROM public.quota_usage_splits s
JOIN public.quota_grants g ON g.id = s.grant_id
WHERE s.event_id = '事件UUID';
```

---

## 5. 刷新用户配额缓存

如果 `user_quotas` 缓存数据看起来不同步，可以强制刷新：

```sql
SELECT refresh_user_quota_cache('用户UUID');
```

---

## 重要说明

1. **幂等性键**: 调用 `refund_quota` 时务必使用唯一的幂等性键，防止意外重复操作。

2. **来源引用**: 务必填写 `source_ref`（工单号或原因说明），便于后续审计。

3. **消费优先级**: 授权按 `consume_priority ASC, valid_to ASC NULLS LAST, created_at ASC` 顺序消费。数字越小越优先消费。

4. **最大视频时长**: 如果 `max_video_seconds = 0`，该授权不能用于视频分析（仅限聊天使用）。
