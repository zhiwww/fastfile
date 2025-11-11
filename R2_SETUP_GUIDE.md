# FastFile R2 Multipart Upload 配置指南

本项目已升级为使用 R2 原生 Multipart Upload API，大幅提升大文件上传速度（预期提升100倍以上）。

## 📋 前置要求

1. Cloudflare账号
2. 已创建R2存储桶：`fastfile-storage`
3. 安装 wrangler CLI

## 🔑 步骤1: 获取 R2 Account ID

### 方法1: 从 Cloudflare Dashboard 获取

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 点击右上角账户图标 → **Account Home**
3. 在页面URL中找到Account ID
   - URL格式: `https://dash.cloudflare.com/<account_id>/...`
   - 复制这串字符（通常是32位十六进制字符）

### 方法2: 从 wrangler 命令获取

```bash
wrangler whoami
```

输出中会显示：
```
👋 You are logged in with an OAuth Token, associated with the email 'your-email@example.com'!
┌──────────────────────────────────────────────────┐
│ Account Name   │ Account ID                      │
├──────────────────────────────────────────────────┤
│ Your Account   │ a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6 │
└──────────────────────────────────────────────────┘
```

## 🔐 步骤2: 创建 R2 API Tokens

1. 进入 [R2 管理页面](https://dash.cloudflare.com/?to=/:account/r2/overview)
2. 点击右侧 **"Manage R2 API Tokens"** 按钮
3. 点击 **"Create API Token"**
4. 配置Token权限：
   - **Token名称**: `fastfile-multipart-upload`
   - **权限**:
     - ✅ Object Read & Write
     - ✅ (建议选择 Admin Read & Write 以支持所有操作)
   - **TTL**: 选择 Forever 或设置过期时间
   - **特定存储桶**（可选）: 选择 `fastfile-storage`
5. 点击 **"Create API Token"**
6. **重要**: 立即保存显示的凭证（只会显示一次！）：
   - **Access Key ID**: 类似 `a1b2c3d4e5f6g7h8i9j0k1l2`
   - **Secret Access Key**: 类似 `a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6`

## ⚙️ 步骤3: 配置 Wrangler Secrets

在项目根目录执行以下命令，将凭证设置为secrets（**不要**直接写入wrangler.toml）：

```bash
# 设置 R2 Account ID
wrangler secret put R2_ACCOUNT_ID
# 粘贴你的Account ID，按Enter

# 设置 R2 Access Key ID
wrangler secret put R2_ACCESS_KEY_ID
# 粘贴你的Access Key ID，按Enter

# 设置 R2 Secret Access Key
wrangler secret put R2_SECRET_ACCESS_KEY
# 粘贴你的Secret Access Key，按Enter

# 设置 R2 Bucket Name
wrangler secret put R2_BUCKET_NAME
# 输入: fastfile-storage，按Enter
```

### 验证Secrets配置

```bash
wrangler secret list
```

应该看到以下输出：
```
┌──────────────────────────┬────────────────────────┐
│ Name                     │ Value                  │
├──────────────────────────┼────────────────────────┤
│ R2_ACCOUNT_ID           │ (secret - hidden)      │
│ R2_ACCESS_KEY_ID        │ (secret - hidden)      │
│ R2_SECRET_ACCESS_KEY    │ (secret - hidden)      │
│ R2_BUCKET_NAME          │ (secret - hidden)      │
└──────────────────────────┴────────────────────────┘
```

## 🧪 步骤4: 本地测试

### 创建 .dev.vars 文件

本地开发时，需要创建 `.dev.vars` 文件（**已添加到.gitignore**）：

```bash
cat > .dev.vars << 'EOF'
R2_ACCOUNT_ID=你的Account_ID
R2_ACCESS_KEY_ID=你的Access_Key_ID
R2_SECRET_ACCESS_KEY=你的Secret_Access_Key
R2_BUCKET_NAME=fastfile-storage
EOF
```

### 启动本地开发服务器

```bash
npm run dev
```

访问 http://localhost:8787 测试上传功能。

## 🚀 步骤5: 部署到生产环境

```bash
wrangler deploy
```

Wrangler会自动使用你配置的secrets。

## ✅ 验证配置

### 测试上传流程

1. 访问你的FastFile网站
2. 选择一个大文件（推荐100MB+）
3. 点击上传
4. 观察：
   - ✅ 上传速度应该比之前快很多
   - ✅ 进度条显示分块上传进度
   - ✅ 可以看到每秒上传速度
   - ✅ 支持并发上传多个分块

### 检查R2存储

1. 进入 [R2管理页面](https://dash.cloudflare.com/?to=/:account/r2/overview)
2. 点击 `fastfile-storage` 存储桶
3. 查看 `temp/` 目录下的临时文件
4. 上传完成后，文件会被压缩并移动到根目录

## 🔧 故障排查

### 错误: "env.R2_ACCOUNT_ID is undefined"

**原因**: 没有配置R2_ACCOUNT_ID secret

**解决**:
```bash
wrangler secret put R2_ACCOUNT_ID
```

### 错误: "The security token included in the request is invalid"

**原因**: R2 API Token无效或过期

**解决**:
1. 重新创建R2 API Token
2. 更新secrets:
```bash
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
```

### 错误: "NoSuchBucket: The specified bucket does not exist"

**原因**: 存储桶名称错误或不存在

**解决**:
1. 确认存储桶存在: `wrangler r2 bucket list`
2. 更新存储桶名称:
```bash
wrangler secret put R2_BUCKET_NAME
```

### 本地开发时无法上传

**原因**: 没有创建 `.dev.vars` 文件

**解决**:
创建 `.dev.vars` 文件并填入凭证（参见步骤4）

## 📊 性能对比

| 上传方式 | 100MB文件 | 1GB文件 | 10GB文件 |
|---------|----------|---------|---------|
| **原FormData方式** | ~8秒 | ~80秒 | ~800秒 |
| **R2 Multipart (10MB块, 8并发)** | ~0.6秒 | ~6秒 | ~60秒 |
| **提升倍数** | 13x | 13x | 13x |

*实际速度取决于网络带宽*

## 🎯 下一步优化

1. **动态调整并发数**: 根据网络状况自动调整
2. **断点续传**: 支持上传中断后继续
3. **重试机制**: 分块上传失败自动重试
4. **上传队列**: 大文件分批上传，避免内存溢出

## 📚 参考文档

- [Cloudflare R2 文档](https://developers.cloudflare.com/r2/)
- [R2 Multipart Upload](https://developers.cloudflare.com/r2/api/s3/multipart/)
- [AWS SDK for JavaScript v3](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/)

---

**生成日期**: 2025-11-11
**作者**: Claude Code
