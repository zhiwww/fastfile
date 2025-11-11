# FastFile 部署指南

## 前置要求

1. Cloudflare账号
2. GitHub账号
3. Node.js 18+

## 部署步骤

### 1. 创建Cloudflare资源

#### 1.1 创建KV命名空间

```bash
wrangler kv:namespace create "FILE_META"
```

记录返回的KV命名空间ID，然后更新`wrangler.toml`中的：
```toml
[[kv_namespaces]]
binding = "FILE_META"
id = "你的KV命名空间ID"  # 替换这里
```

#### 1.2 创建R2存储桶

```bash
wrangler r2 bucket create fastfile-storage
```

确认`wrangler.toml`中的R2配置正确：
```toml
[[r2_buckets]]
binding = "FILE_STORAGE"
bucket_name = "fastfile-storage"
```

### 2. 本地开发测试

#### 2.1 安装依赖

```bash
npm install
```

#### 2.2 本地运行

```bash
npm run dev
```

访问 http://localhost:8787 测试应用。

### 3. 手动部署

```bash
npm run deploy
```

### 4. 配置GitHub Actions自动部署

#### 4.1 获取Cloudflare API Token

1. 访问 https://dash.cloudflare.com/profile/api-tokens
2. 点击"Create Token"
3. 使用"Edit Cloudflare Workers"模板
4. 复制生成的API Token

#### 4.2 配置GitHub Secrets

1. 进入你的GitHub仓库
2. 点击 Settings -> Secrets and variables -> Actions
3. 点击"New repository secret"
4. 名称：`CLOUDFLARE_API_TOKEN`
5. 值：粘贴上一步复制的API Token
6. 点击"Add secret"

#### 4.3 推送代码触发部署

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/你的用户名/fastfile.git
git push -u origin main
```

推送到main分支后，GitHub Actions会自动部署到Cloudflare Workers。

### 5. 验证部署

部署成功后，访问Cloudflare Workers提供的URL（格式：`https://fastfile.你的账号.workers.dev`）来验证应用是否正常运行。

## 功能说明

### 文件上传
- 支持多文件上传
- 自动将多个文件打包为zip（在客户端完成）
- 单个zip文件无需重新打包
- 最大支持10GB文件

### 密码保护
- 4位数字密码
- 密码使用SHA-256哈希存储

### 自动过期
- 文件默认保存30天
- 每天00:00自动清理过期文件（通过Cloudflare Cron Triggers）

### 下载
- 通过短链接分享
- 需要输入密码才能下载

## 自定义配置

### 修改文件保存天数

编辑`src/utils.js`中的`getExpiryTime`函数：

```javascript
// 默认30天，可以修改为其他天数
export function getExpiryTime() {
  return Date.now() + 30 * 24 * 60 * 60 * 1000; // 30天
}
```

### 修改最大文件大小

编辑`src/index.js`中的文件大小检查：

```javascript
// 默认10GB
if (fileSize > 10 * 1024 * 1024 * 1024) {
  return errorResponse('文件大小超过10GB限制');
}
```

同时修改前端页面中的检查（在`serveUploadPage`函数中）。

### 修改密码格式

编辑`src/utils.js`中的`isValidPassword`函数：

```javascript
// 默认4位数字，可以修改正则表达式
export function isValidPassword(password) {
  return /^\d{4}$/.test(password);
}
```

## 故障排查

### 部署失败

1. 检查KV命名空间ID是否正确配置
2. 检查R2存储桶是否创建成功
3. 检查Cloudflare API Token是否有正确的权限

### 文件上传失败

1. 检查文件大小是否超过限制
2. 检查浏览器控制台是否有错误信息
3. 检查Cloudflare Workers日志

### 下载失败

1. 检查文件是否已过期
2. 检查密码是否正确
3. 检查R2存储桶中文件是否存在

## 技术栈

- **前端**: HTML + JavaScript + JSZip
- **后端**: Cloudflare Workers
- **存储**: Cloudflare R2（文件） + KV（元数据）
- **部署**: GitHub Actions

## 注意事项

1. Cloudflare Workers有请求大小限制（100MB），大文件上传可能需要分块上传
2. R2存储按使用量计费，请注意成本
3. KV操作有频率限制，高并发场景需要注意
4. 定时任务需要在Cloudflare Dashboard中启用Cron Triggers
