# FastFile 部署指南

完整的部署和域名配置指南。

## 目录

- [快速部署](#快速部署)
- [详细步骤](#详细步骤)
- [自定义域名配置](#自定义域名配置)
- [功能说明](#功能说明)
- [自定义配置](#自定义配置)
- [故障排查](#故障排查)

## 快速部署

### 前置要求

- Cloudflare 账号
- GitHub 账号
- Node.js 18+

### 5分钟快速开始

```bash
# 1. 安装依赖
npm install

# 2. 创建KV命名空间
wrangler kv:namespace create "FILE_META"
# 记录返回的ID，更新wrangler.toml

# 3. 创建R2存储桶
wrangler r2 bucket create fastfile-storage

# 4. 本地测试
npm run dev

# 5. 部署到Cloudflare
npm run deploy
```

## 详细步骤

### 1. 创建 Cloudflare 资源

#### 1.1 创建 KV 命名空间

```bash
wrangler kv:namespace create "FILE_META"
```

记录返回的 KV 命名空间 ID，然后更新 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "FILE_META"
id = "你的KV命名空间ID"  # 替换这里
```

#### 1.2 创建 R2 存储桶

```bash
wrangler r2 bucket create fastfile-storage
```

#### 1.3 配置 R2 API 凭证

在 Cloudflare Dashboard 中创建 R2 API token：

1. 访问 R2 → Manage R2 API Tokens
2. 创建新的 API Token
3. 记录 Access Key ID 和 Secret Access Key
4. 创建 `.dev.vars` 文件：

```bash
R2_ACCOUNT_ID=你的账号ID
R2_ACCESS_KEY_ID=你的访问密钥ID
R2_SECRET_ACCESS_KEY=你的密钥
R2_BUCKET_NAME=fastfile-storage
```

生产环境使用 secrets：

```bash
wrangler secret put R2_ACCOUNT_ID
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put R2_BUCKET_NAME
```

### 2. 本地开发测试

```bash
# 安装依赖
npm install

# 本地运行
npm run dev
```

访问显示的本地URL（如 `http://localhost:8787`）测试应用。

### 3. 手动部署

```bash
npm run deploy
```

### 4. 配置 GitHub Actions 自动部署

#### 4.1 获取 Cloudflare API Token

1. 访问 https://dash.cloudflare.com/profile/api-tokens
2. 点击 "Create Token"
3. 使用 "Edit Cloudflare Workers" 模板
4. 复制生成的 API Token

#### 4.2 配置 GitHub Secrets

1. 进入 GitHub 仓库
2. Settings → Secrets and variables → Actions
3. 添加以下 secrets：
   - `CLOUDFLARE_API_TOKEN`: 你的 API Token
   - `R2_ACCOUNT_ID`: 你的账号ID
   - `R2_ACCESS_KEY_ID`: R2 访问密钥ID
   - `R2_SECRET_ACCESS_KEY`: R2 密钥
   - `R2_BUCKET_NAME`: `fastfile-storage`

#### 4.3 推送代码触发部署

```bash
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/你的用户名/fastfile.git
git push -u origin main
```

推送到 main 分支后，GitHub Actions 会自动部署。

### 5. 验证部署

访问 Cloudflare Workers 提供的 URL（`https://fastfile.你的账号.workers.dev`）验证应用。

## 自定义域名配置

使用自定义域名（如 `file.example.com`）替代默认的 `workers.dev` 域名。

### 前提条件

- 域名已托管在 Cloudflare DNS
- 域名已添加到 Cloudflare 账户
- SSL/TLS 加密模式设置为 "Full" 或 "Full (strict)"

### 方法一：通过 Cloudflare Dashboard（推荐）

**第1步：配置 DNS 记录**

1. 登录 Cloudflare Dashboard
2. 选择你的域名
3. 进入 **DNS** 标签页
4. 添加记录：
   - Type: `AAAA`
   - Name: `file`（或你想要的子域名）
   - IPv6 address: `100::`
   - Proxy status: **Proxied**（必须开启，橙色云朵）
   - TTL: Auto
5. 点击 Save

**第2步：添加 Workers 路由**

1. 进入 **Workers Routes** 标签页
2. 点击 **Add route**
3. 填写：
   - Route: `file.example.com/*`（替换为你的域名）
   - Service: 选择 `fastfile`
   - Environment: `production`
4. 点击 Save

**第3步：等待生效**

- DNS 记录通常在 1-5 分钟内生效
- 访问 `https://file.example.com` 测试

### 方法二：通过 wrangler.toml 配置

**第1步：编辑配置文件**

编辑 `wrangler.toml`，添加：

```toml
routes = [
  { pattern = "file.example.com/*", zone_name = "example.com" }
]
```

**第2步：配置 DNS**

按照方法一的第1步配置 DNS 记录。

**第3步：重新部署**

```bash
npm run deploy
```

### 多域名支持

在 `wrangler.toml` 中配置多个路由：

```toml
routes = [
  { pattern = "file.example.com/*", zone_name = "example.com" },
  { pattern = "share.example.com/*", zone_name = "example.com" },
  { pattern = "transfer.anotherdomain.com/*", zone_name = "anotherdomain.com" }
]
```

### 验证自定义域名

```bash
# 测试访问
curl -I https://file.example.com

# 检查 DNS 解析
dig file.example.com

# 检查 Cloudflare DNS
dig @1.1.1.1 file.example.com
```

### 域名配置常见问题

#### 无法访问？

检查清单：
- [ ] DNS 记录 Proxy 状态是否为 Proxied（橙色云朵）
- [ ] Workers 路由 pattern 是否正确（注意结尾的 `/*`）
- [ ] 等待 5-10 分钟让 DNS 完全生效
- [ ] 清除浏览器缓存或使用无痕模式

#### SSL 证书错误？

1. SSL/TLS 模式改为 **Full** 或 **Full (strict)**
2. 确保 **Always Use HTTPS** 已开启
3. 等待几分钟让证书生效

#### 404 错误？

- 检查 route pattern 必须以 `/*` 结尾
- 确认 Service 选择了正确的 Worker
- 确认 Environment 为 `production`

#### Workers.dev 域名还能用吗？

可以！自定义域名和 workers.dev 域名可以同时使用，访问的是同一个应用。

## 功能说明

### 文件上传

- 支持多文件上传
- 使用 R2 Multipart Upload（10MB 分块）
- 自动重试机制（最多5次）
- 并发上传（最多4个分块同时上传）
- 支持大文件（理论上无限制）

### 压缩打包

- 多个文件自动打包为 ZIP
- 单个文件直接存储
- 服务端使用 fflate 压缩库
- 支持进度显示

### 密码保护

- 4位数字密码
- 密码使用 SHA-256 哈希存储
- 下载时需要输入密码验证

### 自动过期

- 文件默认保存 30 天
- 每天 00:00 UTC 自动清理过期文件
- 通过 Cloudflare Cron Triggers 实现

### 监控系统

- 结构化日志（JSON 格式）
- 性能指标追踪
- 请求/上传会话追踪
- 支持 Cloudflare Logpush

## 自定义配置

### 修改文件保存天数

编辑 `src/utils.js` 中的 `getExpiryTime` 函数：

```javascript
// 默认30天，可以修改为其他天数
export function getExpiryTime() {
  return Date.now() + 30 * 24 * 60 * 60 * 1000; // 30天
}
```

### 修改分块大小

编辑 `src/index-r2.js` 中的 `CONFIG` 对象：

```javascript
const CONFIG = {
  CHUNK_SIZE: 10 * 1024 * 1024, // 10MB（建议5-50MB）
  MAX_CONCURRENT: 4,             // 并发上传数
  MAX_RETRY_ATTEMPTS: 5,        // 最大重试次数
  RETRY_DELAY_BASE: 1000,       // 基础重试延迟(ms)
};
```

### 修改密码格式

编辑 `src/utils.js` 中的 `isValidPassword` 函数：

```javascript
// 默认4位数字，可以修改正则表达式
export function isValidPassword(password) {
  return /^\d{4}$/.test(password);
}
```

### 配置日志级别

设置环境变量：

```bash
wrangler secret put LOG_LEVEL
# 输入: DEBUG, INFO, WARN, ERROR, FATAL
```

## 故障排查

### 部署失败

**问题**: `wrangler deploy` 失败

**排查**:
1. 检查 KV 命名空间 ID 是否正确
2. 检查 R2 存储桶是否创建成功
3. 检查 Cloudflare API Token 权限
4. 查看完整错误信息

### 文件上传失败

**问题**: 上传时显示错误

**排查**:
1. 打开浏览器控制台查看详细错误
2. 检查 R2 API 凭证是否正确
3. 检查网络连接是否稳定
4. 尝试上传较小的文件测试
5. 查看 Cloudflare Workers 日志

### 分块上传错误

**问题**: "EntityTooSmall" 或分块上传失败

**解决**:
1. 确保 CHUNK_SIZE ≥ 5MB（R2 最小分块限制）
2. 检查最后一个分块是否正确
3. 查看服务器日志确认分块大小

### 压缩失败

**问题**: 上传完成但压缩失败

**排查**:
1. 检查文件是否成功上传到 R2
2. 查看 Worker 日志中的错误信息
3. 确认 R2 API 凭证配置正确
4. 测试较小的文件

### 下载失败

**问题**: 无法下载文件

**排查**:
1. 检查文件是否已过期
2. 验证密码是否正确
3. 检查 R2 存储桶中文件是否存在
4. 查看浏览器控制台错误

### 自动清理不工作

**问题**: 过期文件没有被删除

**排查**:
1. 检查 Cron Trigger 是否在 Dashboard 中配置
2. 查看 Worker 日志确认清理任务执行
3. 手动触发清理：`curl https://你的域名/api/cleanup`

### 监控日志查看

```bash
# 实时查看日志
wrangler tail

# 查看 JSON 格式日志
wrangler tail --format json

# 过滤错误日志
wrangler tail --format json | jq 'select(.level == "ERROR")'

# 追踪特定上传
wrangler tail --format json | jq 'select(.uploadId == "abc123")'
```

## 性能优化建议

### 上传性能

1. **调整分块大小**: 根据用户网络情况调整 CHUNK_SIZE（5-50MB）
2. **并发控制**: MAX_CONCURRENT 建议 3-6 之间
3. **重试策略**: 根据错误率调整 MAX_RETRY_ATTEMPTS
4. **网络优化**: 使用 Cloudflare 的边缘网络加速

### 存储成本

1. **过期时间**: 根据需求调整文件保存天数
2. **自动清理**: 确保 Cron Trigger 正常运行
3. **监控用量**: 定期检查 R2 存储用量

### Worker 性能

1. **CPU 限制**: 单个请求不超过 50ms CPU 时间
2. **内存使用**: 避免在内存中处理超大文件
3. **并发连接**: 使用 R2 Multipart Upload 避免超大请求

## 技术栈

- **前端**: HTML + JavaScript + Fetch API
- **后端**: Cloudflare Workers
- **存储**: Cloudflare R2（文件）+ KV（元数据）
- **压缩**: fflate（WebAssembly）
- **上传**: R2 Multipart Upload API (aws4fetch)
- **监控**: 结构化日志 + Metrics
- **部署**: GitHub Actions

## 注意事项

1. **R2 Multipart Upload 限制**:
   - 最小分块大小：5MB（除最后一个分块）
   - 最大分块数：10,000
   - 单个分块最大：5GB

2. **Cloudflare Workers 限制**:
   - CPU 时间：最多 50ms/请求（Workers Paid: 30s）
   - 内存：128MB
   - 请求体大小：100MB（使用 streams 可突破）

3. **成本考虑**:
   - R2 存储：$0.015/GB/月
   - R2 操作：Class A 免费，Class B 免费
   - Workers 请求：免费套餐 100,000 请求/天
   - KV 操作：免费套餐 100,000 读/天

4. **安全建议**:
   - 定期更新密码格式和长度
   - 启用 Cloudflare 的 WAF 和速率限制
   - 监控异常上传活动
   - 定期审计存储内容

## 相关文档

- [R2 配置指南](./R2_SETUP.md) - R2 和 Multipart Upload 详细说明
- [监控系统](./MONITORING.md) - 日志和监控配置
- [性能优化](./OPTIMIZATION.md) - 性能调优和最佳实践
- [技术文档](../CLAUDE.md) - 完整技术文档（供 AI 助手参考）

---

**版本**: 2.0.0 (R2 Multipart Upload)
**更新时间**: 2025-11-12
**支持**: [GitHub Issues](https://github.com/zhiwww/fastfile/issues)
