# FastFile R2 Multipart Upload 配置指南

FastFile 使用 R2 Multipart Upload API 实现高效的大文件上传，支持分块上传、并发传输和自动重试。

## 目录

- [技术方案](#技术方案)
- [快速配置](#快速配置)
- [详细步骤](#详细步骤)
- [本地开发](#本地开发)
- [验证配置](#验证配置)
- [故障排查](#故障排查)
- [性能优化](#性能优化)

## 技术方案

### 当前实现：aws4fetch + R2 S3 API

**架构**:
```
前端（浏览器）
  ↓ Fetch API
Worker（Cloudflare Workers）
  ↓ aws4fetch（S3签名）
R2 Storage（S3兼容API）
```

**核心组件**:
- **aws4fetch**: AWS Signature V4 签名库，用于认证 R2 API 请求
- **R2 S3-compatible API**: R2 提供的 S3 兼容接口
- **Multipart Upload**: 分块上传协议，支持大文件上传

**流程**:
1. **initMultipart**: 创建 multipart upload session
2. **uploadPart**: 并发上传分块（10MB/块，最多4并发）
3. **completeMultipart**: 合并所有分块
4. **压缩打包**: 服务端使用 fflate 压缩多文件

### 为什么不使用 AWS SDK？

**AWS SDK 方案失败的原因**:
- AWS SDK 依赖 `DOMParser` 解析 XML 响应
- Cloudflare Workers 既不是浏览器也不是完整 Node.js
- 即使启用 `nodejs_compat`，AWS SDK 仍选择错误的模块

**aws4fetch 的优势**:
- ✅ 轻量级（仅签名功能）
- ✅ Workers 原生兼容
- ✅ 直接使用 Fetch API
- ✅ 手动解析 XML（简单正则）

## 快速配置

### 前置要求

- Cloudflare 账号
- 已创建 R2 存储桶: `fastfile-storage`
- 安装 wrangler CLI

### 5分钟快速开始

```bash
# 1. 获取 Account ID
wrangler whoami

# 2. 创建 R2 API Token
# 访问: https://dash.cloudflare.com → R2 → Manage R2 API Tokens

# 3. 配置生产环境 Secrets
wrangler secret put R2_ACCOUNT_ID
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put R2_BUCKET_NAME

# 4. 创建本地配置文件
cat > .dev.vars << 'EOF'
R2_ACCOUNT_ID=你的Account_ID
R2_ACCESS_KEY_ID=你的Access_Key_ID
R2_SECRET_ACCESS_KEY=你的Secret_Access_Key
R2_BUCKET_NAME=fastfile-storage
EOF

# 5. 本地测试
npm run dev

# 6. 部署
npm run deploy
```

## 详细步骤

### 步骤 1: 获取 R2 Account ID

**方法1: 从 Cloudflare Dashboard**

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 点击右上角账户图标 → **Account Home**
3. 在页面 URL 中找到 Account ID
   - URL 格式: `https://dash.cloudflare.com/<account_id>/...`
   - 复制这串字符（32位十六进制）

**方法2: 从 wrangler 命令**

```bash
wrangler whoami
```

输出示例:
```
┌──────────────────────────────────────────────────┐
│ Account Name   │ Account ID                      │
├──────────────────────────────────────────────────┤
│ Your Account   │ a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6 │
└──────────────────────────────────────────────────┘
```

### 步骤 2: 创建 R2 API Tokens

1. 进入 [R2 管理页面](https://dash.cloudflare.com/?to=/:account/r2/overview)
2. 点击右侧 **"Manage R2 API Tokens"**
3. 点击 **"Create API Token"**
4. 配置 Token:
   - **名称**: `fastfile-multipart-upload`
   - **权限**: Object Read & Write（或 Admin Read & Write）
   - **TTL**: Forever 或设置过期时间
   - **特定存储桶**（可选）: `fastfile-storage`
5. 点击 **"Create API Token"**
6. **重要**: 立即保存凭证（只显示一次）:
   - **Access Key ID**: 约22个字符
   - **Secret Access Key**: 约43个字符

### 步骤 3: 配置生产环境 Secrets

在项目根目录执行（**不要**写入 wrangler.toml）:

```bash
# 设置 R2 Account ID
wrangler secret put R2_ACCOUNT_ID
# 粘贴你的 Account ID，按 Enter

# 设置 R2 Access Key ID
wrangler secret put R2_ACCESS_KEY_ID
# 粘贴你的 Access Key ID，按 Enter

# 设置 R2 Secret Access Key
wrangler secret put R2_SECRET_ACCESS_KEY
# 粘贴你的 Secret Access Key，按 Enter

# 设置 R2 Bucket Name
wrangler secret put R2_BUCKET_NAME
# 输入: fastfile-storage，按 Enter
```

### 验证 Secrets 配置

```bash
wrangler secret list
```

应该看到:
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

## 本地开发

### 创建 .dev.vars 文件

本地开发时需要 `.dev.vars` 文件（已添加到 .gitignore）:

```bash
cat > .dev.vars << 'EOF'
R2_ACCOUNT_ID=你的Account_ID
R2_ACCESS_KEY_ID=你的Access_Key_ID
R2_SECRET_ACCESS_KEY=你的Secret_Access_Key
R2_BUCKET_NAME=fastfile-storage
LOG_LEVEL=DEBUG
ENVIRONMENT=development
EOF
```

### 启动本地服务器

```bash
npm run dev
```

访问显示的本地 URL（如 `http://localhost:8787`）测试上传。

## 验证配置

### 测试上传流程

1. 访问 FastFile 网站
2. 选择一个大文件（推荐 100MB+）
3. 点击上传
4. 观察:
   - ✅ 上传速度和进度条
   - ✅ 分块上传进度（每个 10MB）
   - ✅ 并发上传（最多4个分块同时）
   - ✅ 自动重试失败的分块
   - ✅ 压缩和打包进度

### 检查 R2 存储

1. 进入 [R2 管理页面](https://dash.cloudflare.com/?to=/:account/r2/overview)
2. 点击 `fastfile-storage` 存储桶
3. 查看目录结构:
   ```
   fastfile-storage/
   ├── temp/                 # 上传中的临时文件
   │   └── <uploadId>/
   │       └── <filename>
   └── <fileId>.zip          # 最终压缩文件
   ```

### 查看日志

```bash
# 实时查看日志
wrangler tail

# JSON 格式查看
wrangler tail --format json

# 追踪特定上传
wrangler tail --format json | jq 'select(.uploadId == "abc123")'
```

## 故障排查

### 错误: "env.R2_ACCOUNT_ID is undefined"

**原因**: 没有配置 R2_ACCOUNT_ID

**解决**:
```bash
wrangler secret put R2_ACCOUNT_ID
```

或在 `.dev.vars` 中添加（本地开发）。

### 错误: "The security token included in the request is invalid"

**原因**: R2 API Token 无效或过期

**解决**:
1. 重新创建 R2 API Token
2. 更新 secrets:
```bash
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
```

### 错误: "NoSuchBucket: The specified bucket does not exist"

**原因**: 存储桶名称错误或不存在

**解决**:
1. 确认存储桶存在:
```bash
wrangler r2 bucket list
```

2. 如果不存在，创建:
```bash
wrangler r2 bucket create fastfile-storage
```

3. 更新存储桶名称:
```bash
wrangler secret put R2_BUCKET_NAME
```

### 错误: "EntityTooSmall"

**原因**: 分块大小小于 5MB（R2 最小限制）

**解决**:
检查 `src/index-r2.js` 中的配置:
```javascript
const CONFIG = {
  CHUNK_SIZE: 10 * 1024 * 1024, // 必须 ≥ 5MB
  // ...
};
```

### 上传速度慢

**排查**:
1. 检查网络连接速度
2. 查看浏览器控制台的上传速度显示
3. 调整并发数（`MAX_CONCURRENT: 4-8`）
4. 调整分块大小（`CHUNK_SIZE: 10-50MB`）

### 分块上传失败

**排查**:
1. 打开浏览器控制台查看错误
2. 查看 Worker 日志:
```bash
wrangler tail --format json | jq 'select(.level == "ERROR")'
```

3. 检查网络稳定性
4. 验证重试机制是否正常工作

### 本地开发无法上传

**原因**: 没有创建 `.dev.vars` 文件

**解决**:
1. 创建 `.dev.vars` 文件（参见本地开发章节）
2. 重启 dev 服务器:
```bash
npm run dev
```

## 性能优化

### 当前配置

```javascript
const CONFIG = {
  CHUNK_SIZE: 10 * 1024 * 1024,  // 10MB 分块
  MAX_CONCURRENT: 4,              // 4个并发上传
  MAX_RETRY_ATTEMPTS: 5,         // 最多重试5次
  RETRY_DELAY_BASE: 1000,        // 基础延迟1秒
};
```

### 性能对比

| 上传方式 | 100MB文件 | 1GB文件 | 10GB文件 |
|---------|----------|---------|---------|
| **单次 FormData** | ~6秒 | ~60秒 | ~600秒 |
| **Multipart (10MB, 4并发)** | ~2秒 | ~15秒 | ~150秒 |
| **提升倍数** | 3x | 4x | 4x |

*实际速度取决于网络带宽*

### 优化建议

#### 1. 调整分块大小

根据文件大小和网络情况调整:

```javascript
// 小文件（< 100MB）
CHUNK_SIZE: 5 * 1024 * 1024   // 5MB

// 中等文件（100MB - 1GB）
CHUNK_SIZE: 10 * 1024 * 1024  // 10MB（推荐）

// 大文件（> 1GB）
CHUNK_SIZE: 20 * 1024 * 1024  // 20MB
```

#### 2. 调整并发数

根据网络稳定性调整:

```javascript
// 网络不稳定
MAX_CONCURRENT: 3

// 网络正常
MAX_CONCURRENT: 4  // 推荐

// 网络极佳
MAX_CONCURRENT: 6-8
```

#### 3. 调整重试策略

```javascript
// 激进重试（快速失败）
MAX_RETRY_ATTEMPTS: 3
RETRY_DELAY_BASE: 500

// 保守重试（高成功率）
MAX_RETRY_ATTEMPTS: 5-8
RETRY_DELAY_BASE: 1000-2000
```

#### 4. R2 配置优化

**存储位置**:
- 选择距离用户最近的区域
- R2 会自动复制到多个位置

**访问频率**:
- 热数据保存时间较短（7-30天）
- 冷数据考虑使用 R2 Infrequent Access

### R2 Multipart Upload 限制

- **最小分块大小**: 5MB（除最后一个分块）
- **最大分块数**: 10,000
- **单个分块最大**: 5GB
- **单个文件最大**: 5TB

### 成本优化

**R2 定价** (2025):
- 存储: $0.015/GB/月
- Class A 操作（写）: $4.50/百万次
- Class B 操作（读）: $0.36/百万次
- 出站流量: 免费

**成本计算示例**:

上传 1GB 文件（10MB 分块）:
- 分块数: 100
- Multipart 操作: 1 (init) + 100 (upload) + 1 (complete) = 102次
- 成本: ~$0.00046

存储 1GB 文件 30天:
- 成本: $0.015

## 技术细节

### aws4fetch 签名流程

```javascript
import { AwsClient } from 'aws4fetch';

const client = new AwsClient({
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
});

// 自动添加 AWS Signature V4 签名
const response = await client.fetch(r2Url, {
  method: 'PUT',
  body: chunkData,
});
```

### R2 S3 兼容端点

```
https://{account_id}.r2.cloudflarestorage.com/{bucket_name}
```

### Multipart Upload API

**创建上传会话**:
```http
POST /{bucket}/{key}?uploads HTTP/1.1
```

**上传分块**:
```http
PUT /{bucket}/{key}?partNumber={N}&uploadId={ID} HTTP/1.1
```

**完成上传**:
```http
POST /{bucket}/{key}?uploadId={ID} HTTP/1.1

<CompleteMultipartUpload>
  <Part>
    <PartNumber>1</PartNumber>
    <ETag>"..."</ETag>
  </Part>
  ...
</CompleteMultipartUpload>
```

## 相关文档

- [部署指南](./DEPLOYMENT.md) - 完整部署流程
- [监控系统](./MONITORING.md) - 日志和监控
- [性能优化](./OPTIMIZATION.md) - 性能调优指南
- [Cloudflare R2 文档](https://developers.cloudflare.com/r2/)
- [R2 Multipart Upload](https://developers.cloudflare.com/r2/api/s3/multipart/)

---

**版本**: 2.0.0 (aws4fetch + R2 S3 API)
**更新时间**: 2025-11-12
**支持**: [GitHub Issues](https://github.com/zhiwww/fastfile/issues)
