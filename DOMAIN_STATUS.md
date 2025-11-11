# FastFile - 自定义域名配置状态

## ✅ 当前配置

**自定义域名**: `fastfile.zwi.monster`
**根域名**: `zwi.monster`
**配置文件**: `wrangler.toml`

```toml
routes = [
  { pattern = "fastfile.zwi.monster/*", zone_name = "zwi.monster" }
]
```

## 📋 下一步操作

### 1. 配置Cloudflare DNS

在Cloudflare Dashboard中为 `zwi.monster` 域名添加DNS记录：

```
Type: AAAA
Name: fastfile
IPv6 address: 100::
Proxy status: Proxied（橙色云朵，必须开启）
TTL: Auto
```

### 2. 验证配置

部署后，访问以下URL验证：
- https://fastfile.zwi.monster

### 3. 可访问的URL

配置完成后，FastFile可以通过以下URL访问：

✅ **Workers.dev域名**（默认）
- `https://fastfile.你的cloudflare账号.workers.dev`

✅ **自定义域名**（已配置）
- `https://fastfile.zwi.monster`

两个域名可以同时使用！

## 🔧 管理自定义域名

### 添加更多域名

在 `wrangler.toml` 中添加更多路由：

```toml
routes = [
  { pattern = "fastfile.zwi.monster/*", zone_name = "zwi.monster" },
  { pattern = "share.zwi.monster/*", zone_name = "zwi.monster" },
  { pattern = "upload.zwi.monster/*", zone_name = "zwi.monster" }
]
```

### 暂时禁用自定义域名

注释掉routes配置：

```toml
# routes = [
#   { pattern = "fastfile.zwi.monster/*", zone_name = "zwi.monster" }
# ]
```

### 更换域名

修改pattern和zone_name即可：

```toml
routes = [
  { pattern = "newdomain.example.com/*", zone_name = "example.com" }
]
```

## 📝 部署方法

### 方法一：使用GitHub Actions（推荐）

推送代码到master分支会自动部署：

```bash
git add .
git commit -m "配置自定义域名"
git push origin master
```

### 方法二：手动部署

```bash
npm run deploy
```

## ✨ 域名生效时间

- **DNS记录**: 1-5分钟
- **Workers路由**: 立即生效
- **SSL证书**: 自动生成（1-2分钟）

## 🆘 常见问题

### 域名无法访问？

1. 检查DNS记录Proxy状态是否为Proxied
2. 等待5-10分钟让DNS完全生效
3. 清除浏览器缓存
4. 使用 `dig file.zwi.monster` 检查DNS解析

### SSL证书错误？

1. 在Cloudflare Dashboard中
2. 进入 SSL/TLS 设置
3. 确保模式为 "Full" 或 "Full (strict)"
4. 开启 "Always Use HTTPS"

## 📚 相关文档

- [CUSTOM_DOMAIN.md](./CUSTOM_DOMAIN.md) - 快速配置指南
- [DEPLOYMENT.md](./DEPLOYMENT.md) - 完整部署指南
- [README.md](./README.md) - 项目说明

---

**提示**: 自定义域名配置完全免费，且不影响workers.dev域名的使用！
