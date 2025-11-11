# 自定义域名配置快速指南

本指南帮助你快速为FastFile配置自定义域名，如 `file.example.com`。

## 📋 准备工作

- ✅ 拥有一个域名
- ✅ 域名已添加到Cloudflare账户
- ✅ FastFile已成功部署到Cloudflare Workers

## 🚀 快速配置（5分钟完成）

### 第1步：登录Cloudflare Dashboard

访问 https://dash.cloudflare.com 并选择你的域名

### 第2步：配置DNS记录

1. 进入 **DNS** 标签页
2. 点击 **Add record**
3. 填写以下信息：
   ```
   Type: AAAA
   Name: file （或你想要的子域名）
   IPv6 address: 100::
   Proxy status: Proxied（必须开启，橙色云朵）
   TTL: Auto
   ```
4. 点击 **Save**

### 第3步：添加Workers路由

**方式A：通过Dashboard（推荐新手）**

1. 进入 **Workers Routes** 标签页
2. 点击 **Add route**
3. 填写：
   - Route: `file.example.com/*` （替换为你的域名）
   - Service: 选择 `fastfile`
   - Environment: `production`
4. 点击 **Save**

**方式B：通过wrangler.toml（推荐开发者）**

编辑 `wrangler.toml` 文件，添加：

```toml
routes = [
  { pattern = "file.example.com/*", zone_name = "example.com" }
]
```

然后重新部署：
```bash
npm run deploy
```

### 第4步：等待生效

- DNS通常在 **1-5分钟** 内生效
- 访问 `https://file.example.com` 测试

## ✅ 验证配置

```bash
# 命令行测试
curl -I https://file.example.com

# 或在浏览器中打开
https://file.example.com
```

如果能看到FastFile上传页面，说明配置成功！

## 🌟 进阶配置

### 多个子域名

你可以为同一个应用配置多个子域名：

```toml
routes = [
  { pattern = "file.example.com/*", zone_name = "example.com" },
  { pattern = "share.example.com/*", zone_name = "example.com" },
  { pattern = "upload.example.com/*", zone_name = "example.com" }
]
```

### 多个域名

支持不同的根域名：

```toml
routes = [
  { pattern = "file.example.com/*", zone_name = "example.com" },
  { pattern = "transfer.yourdomain.com/*", zone_name = "yourdomain.com" }
]
```

### 强制HTTPS

在Cloudflare Dashboard中：
1. 进入 **SSL/TLS** 标签页
2. 加密模式选择 **Full** 或 **Full (strict)**
3. 进入 **Edge Certificates**
4. 开启 **Always Use HTTPS**

## 🔧 常见问题

### ❌ 无法访问

**检查清单**：
- [ ] DNS记录Proxy状态是否为Proxied（橙色云朵）
- [ ] Workers路由pattern是否正确（注意结尾的 `/*`）
- [ ] 等待5-10分钟让DNS完全生效
- [ ] 清除浏览器缓存或使用无痕模式

### ❌ SSL证书错误

**解决方法**：
1. SSL/TLS模式改为 **Full** 或 **Full (strict)**
2. 确保 **Always Use HTTPS** 已开启
3. 等待几分钟让证书生效

### ❌ 404错误

**原因**：Workers路由配置有误

**解决**：
- 检查route pattern必须以 `/*` 结尾
- 确认Service选择了正确的Worker
- 确认Environment为 `production`

### ❌ DNS不生效

**排查步骤**：
```bash
# 检查DNS解析
dig file.example.com

# 或使用nslookup
nslookup file.example.com

# 检查Cloudflare的DNS
dig @1.1.1.1 file.example.com
```

### ⚠️ Workers.dev域名冲突？

**不会冲突！**
- 自定义域名和workers.dev域名可以同时使用
- 两个域名访问的是同一个应用
- 下载链接会根据访问域名自动适配

## 💡 提示

1. **推荐使用子域名**：如 `file.example.com`，而不是根域名 `example.com`
2. **Proxy必须开启**：DNS记录的Proxy status必须是Proxied（橙色云朵）
3. **不需要修改代码**：应用会自动适配任何域名
4. **免费使用**：Cloudflare Workers的自定义域名功能完全免费

## 🆘 需要帮助？

如果配置过程中遇到问题：

1. 查看完整文档：[DEPLOYMENT.md](./DEPLOYMENT.md#自定义域名配置)
2. 检查Cloudflare状态：https://www.cloudflarestatus.com
3. 查看Cloudflare文档：https://developers.cloudflare.com/workers/configuration/routing/routes/

---

**配置成功后，你可以**：
- 使用 `https://file.example.com` 访问应用
- 分享更专业的下载链接
- 继续使用 `workers.dev` 域名作为备用
