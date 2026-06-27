# 管理员账户设置指南

## 初始设置第一个管理员

由于 `admin_users` 表使用 RLS（Row Level Security），只有 `service_role` 可以插入数据，所以第一个管理员需要通过 SQL 直接添加。

### 方法 1: 使用 Supabase Dashboard

1. 登录 Supabase Dashboard
2. 进入 SQL Editor
3. 执行以下 SQL（替换 `YOUR_USER_ID` 为实际的用户 UUID）：

```sql
-- 查找用户 ID（如果知道邮箱）
SELECT id, email FROM auth.users WHERE email = 'your-email@example.com';

-- 添加管理员（使用上面查询到的 user_id）
INSERT INTO public.admin_users (user_id)
VALUES ('YOUR_USER_ID'::uuid);
```

### 方法 2: 使用 Supabase CLI

```bash
# 连接到本地 Supabase
supabase db reset

# 或者直接执行 SQL
supabase db execute "
  INSERT INTO public.admin_users (user_id)
  SELECT id FROM auth.users WHERE email = 'your-email@example.com';
"
```

### 方法 3: 使用迁移文件

创建一个新的迁移文件，例如 `supabase/migrations/YYYYMMDDHHMMSS_add_initial_admin.sql`:

```sql
-- 添加初始管理员（替换为实际的用户邮箱）
INSERT INTO public.admin_users (user_id)
SELECT id FROM auth.users WHERE email = 'admin@your-domain.example'
ON CONFLICT (user_id) DO NOTHING;
```

## 管理员密码设置

管理员的密码通过 Supabase Auth 管理。有以下几种方式设置密码：

### 方法 1: 通过 Supabase Dashboard 创建用户（推荐）

1. 登录 Supabase Dashboard
2. 进入 **Authentication** > **Users**
3. 点击 **Add user** > **Create new user**
4. 输入：
   - **Email**: 管理员邮箱（如 `admin@your-domain.example`）
   - **Password**: 设置初始密码
   - **Auto Confirm User**: 勾选（跳过邮箱验证）
5. 点击 **Create user**
6. 然后按照下面的步骤将用户添加为管理员

### 方法 2: 通过 Supabase CLI 创建用户

```bash
# 使用 Supabase CLI 创建用户（需要 service_role key）
supabase auth admin create-user \
  --email admin@your-domain.example \
  --password "REPLACE_WITH_STRONG_PASSWORD" \
  --email-confirm
```

### 方法 3: 通过 API 创建用户（需要 service_role）

```javascript
// 使用 Supabase Admin API
const { data, error } = await supabase.auth.admin.createUser({
  email: 'admin@your-domain.example',
  password: 'REPLACE_WITH_STRONG_PASSWORD',
  email_confirm: true
});
```

### 方法 4: 用户自行注册（如果启用了公开注册）

如果 Supabase 项目启用了公开注册（`enable_signup = true`），用户可以：
1. 访问应用的注册页面（如果有）
2. 或通过 Supabase Auth API 自行注册

## 密码重置

### 通过 Supabase Dashboard

1. 进入 **Authentication** > **Users**
2. 找到要重置密码的用户
3. 点击用户行右侧的 **...** 菜单
4. 选择 **Reset password**
5. 系统会发送密码重置邮件给用户

### 通过 API（前端功能）

用户可以通过登录页面的"忘记密码"功能重置密码（需要添加此功能）。

### 通过 Supabase CLI

```bash
# 发送密码重置邮件
supabase auth admin generate-link \
  --type recovery \
  --email admin@your-domain.example
```

### 管理员直接重置密码（需要 service_role）

```sql
-- 注意：Supabase Auth 的密码是加密存储的，不能直接通过 SQL 修改
-- 必须使用 Supabase Admin API 或 Dashboard
```

## 用户注册流程

1. **创建用户账户并设置密码**
   - 通过 Supabase Dashboard 创建用户（推荐）
   - 或通过 Supabase CLI 创建
   - 或通过 API 创建（需要 service_role）

2. **添加为管理员**
   - 使用第一个管理员账户登录管理面板
   - 进入 "Admin Users" 页面
   - **方式 A - 添加现有用户**:
     - 输入用户的邮箱地址
     - 点击 "Add" 按钮
   - **方式 B - 创建新用户并添加**:
     - 输入邮箱地址
     - 勾选 "Create new user if doesn't exist"
     - 输入密码（至少 6 位）
     - 点击 "Create & Add" 按钮

## 管理员管理

### 通过管理面板

1. 登录管理面板
2. 点击 "Admin Users" 按钮
3. 可以：
   - **添加管理员**: 输入邮箱地址并点击 "Add"
   - **删除管理员**: 点击用户行的删除按钮（不能删除自己）

### 通过 SQL

```sql
-- 查看所有管理员
SELECT 
  au.user_id,
  au.created_at,
  u.email
FROM public.admin_users au
LEFT JOIN auth.users u ON u.id = au.user_id
ORDER BY au.created_at DESC;

-- 添加管理员
INSERT INTO public.admin_users (user_id)
SELECT id FROM auth.users WHERE email = 'new-admin@your-domain.example';

-- 删除管理员
DELETE FROM public.admin_users 
WHERE user_id = (SELECT id FROM auth.users WHERE email = 'admin-to-remove@your-domain.example');
```

## 完整设置流程示例

### 首次设置管理员账户

1. **创建用户账户**
   ```bash
   # 通过 Supabase Dashboard
   # Authentication > Users > Add user > Create new user
   # Email: admin@your-domain.example
   # Password: REPLACE_WITH_STRONG_PASSWORD
   # Auto Confirm User: ✓
   ```

2. **添加为管理员**
   ```sql
   -- 在 Supabase SQL Editor 中执行
   INSERT INTO public.admin_users (user_id)
   SELECT id FROM auth.users WHERE email = 'admin@your-domain.example';
   ```

3. **登录管理面板**
   - 访问管理面板 URL
   - 使用邮箱和密码登录
   - 现在可以管理其他管理员账户了

## 安全注意事项

1. **第一个管理员**: 必须通过 SQL 或 Supabase Dashboard 手动添加
2. **不能删除自己**: 系统会阻止管理员删除自己的账户
3. **RLS 保护**: `admin_users` 表受 RLS 保护，只有 service_role 可以修改
4. **用户必须存在**: 添加管理员时，用户必须已经在 `auth.users` 中存在
5. **密码安全**: 
   - 使用强密码（至少 8 位，包含大小写字母、数字和特殊字符）
   - 定期更换密码
   - 不要共享管理员账户
6. **密码存储**: Supabase Auth 使用 bcrypt 加密存储密码，不能直接通过 SQL 查看或修改

## 故障排查

### 用户无法登录管理面板

1. 检查用户是否在 `admin_users` 表中：
   ```sql
   SELECT * FROM public.admin_users WHERE user_id = 'USER_ID';
   ```

2. 检查用户是否已通过 Supabase Auth 认证

3. 检查 RLS 策略是否正常工作

### 添加管理员失败

1. 确认用户邮箱是否正确
2. 确认用户是否已在 `auth.users` 中存在
3. 检查是否已经是管理员（重复添加会失败）

### 忘记密码

1. 在登录页面点击 "Forgot password?"
2. 输入邮箱地址
3. 检查邮箱中的密码重置链接
4. 点击链接设置新密码

### 密码重置链接无效

1. 确认链接是否过期（通常 1 小时有效）
2. 检查邮箱是否正确
3. 可以通过 Supabase Dashboard 重新发送重置邮件
4. 或使用 Supabase CLI 生成新的重置链接
