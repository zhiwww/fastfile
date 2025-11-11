# FastFile

基于 Cloudflare 技术栈的无需注册大文件中转应用，支持最大 10GB 文件的临时存储和分享。

## 功能特性

- **无需注册**：用户无需注册账号即可上传和下载文件
- **大文件支持**：支持最大 10GB 的文件上传（分块上传 + 自动重试）
- **多文件上传**：支持一次性上传多个文件，自动打包为 zip
- **密码保护**：使用 4 位数字密码保护文件安全
- **自动过期**：文件默认保存 30 天后自动删除
- **完整监控**：结构化日志 + 性能指标 + 请求追踪
- **自定义域名**：支持绑定自己的域名
- **移动端适配**：完美支持手机和平板电脑访问

## 快速开始

### 本地开发

```bash
# 1. 克隆项目
git clone https://github.com/your-username/fastfile.git
cd fastfile

# 2. 安装依赖
npm install

# 3. 配置环境（参考 docs/DEPLOYMENT.md）
wrangler kv:namespace create "FILE_META"
wrangler r2 bucket create fastfile-storage

# 4. 本地运行
npm run dev

# 5. 访问 http://localhost:8787
```

### 部署到生产环境

详细部署步骤请查看 [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)

```bash
# 快速部署
npm run deploy
```

## 技术栈

| 技术 | 用途 |
|------|------|
| Cloudflare Workers | 无服务器计算平台 |
| Cloudflare R2 | 对象存储（文件存储） |
| Cloudflare KV | 键值存储（元数据） |
| aws4fetch | R2 S3 API 签名 |
| fflate | 高性能压缩库 |

## 项目结构

```
fastfile/
├── src/
│   ├── index-r2.js         # Worker 主入口（R2 Multipart Upload）
│   ├── logger.js           # 结构化日志系统
│   └── utils.js            # 工具函数
├── docs/
│   ├── DEPLOYMENT.md       # 部署指南
│   ├── R2_SETUP.md         # R2 配置指南
│   ├── MONITORING.md       # 监控系统文档
│   └── OPTIMIZATION.md     # 性能优化指南
├── wrangler.toml           # Cloudflare 配置
├── package.json            # 项目配置
├── CLAUDE.md               # 技术文档（AI助手专用）
└── README.md               # 本文件
```

## 核心功能

### 分块上传

使用 R2 Multipart Upload API，支持大文件上传：

- **分块大小**：10MB/块
- **并发上传**：最多 4 个并发请求
- **自动重试**：最多重试 5 次
- **断点续传**：支持上传失败后继续

### 智能重试

指数退避算法自动重试临时错误：

- 自动识别 14 种网络错误模式
- 最多 6 次尝试（1次原始 + 5次重试）
- 随机抖动避免请求风暴
- 不阻塞其他 chunk 上传

### 完整监控

结构化日志 + 性能指标：

- JSON 格式日志，易于查询
- 请求级别追踪
- 上传会话追踪
- 性能指标收集
- Grafana/Loki 兼容

## 使用说明

### 上传文件

1. 访问应用首页
2. 选择一个或多个文件（最大 10GB）
3. 设置 4 位数字密码
4. 点击"上传文件"
5. 复制下载链接和密码分享

### 下载文件

1. 打开下载链接
2. 输入密码
3. 点击"下载文件"

### 查看日志

```bash
# 实时日志
wrangler tail

# 过滤错误日志
wrangler tail --format json | jq 'select(.level == "ERROR")'

# 监控特定上传
wrangler tail --format json | jq 'select(.uploadId == "abc123")'
```

## 性能数据

| 文件大小 | 上传时间 | 吞吐量 |
|---------|---------|--------|
| 100MB | ~20秒 | ~5 MB/s |
| 1GB | ~3分钟 | ~5.5 MB/s |
| 10GB | ~30分钟 | ~5.5 MB/s |

注：实际速度受用户网络带宽限制。

## 文档导航

### 新手入门
- [部署指南](./docs/DEPLOYMENT.md) - 完整的部署步骤
- [R2 配置](./docs/R2_SETUP.md) - R2 Multipart Upload 配置

### 运维指南
- [监控系统](./docs/MONITORING.md) - 日志、指标、追踪
- [性能优化](./docs/OPTIMIZATION.md) - 配置调优、最佳实践

### 开发指南
- [技术文档](./CLAUDE.md) - 架构设计、核心代码说明

## 安全特性

- 密码使用 SHA-256 哈希存储
- 下载需要临时令牌验证
- 文件 ID 随机生成
- 自动过期清理

## 限制说明

| 项目 | 限制 |
|------|------|
| 单次上传最大 | 10GB |
| 文件保存时间 | 30天 |
| Workers CPU时间 | 150秒（可配置） |
| R2 对象最大 | 5TB |
| KV 值最大 | 25MB |

## 配置调优

根据网络环境调整配置（`src/index-r2.js`）：

```javascript
// 高速网络
const CONFIG = {
  MAX_CONCURRENT: 8,     // 更多并发
  CHUNK_SIZE: 20 * 1024 * 1024  // 20MB
};

// 弱网环境
const CONFIG = {
  MAX_CONCURRENT: 2,     // 更少并发
  CHUNK_SIZE: 5 * 1024 * 1024   // 5MB
};
```

详细配置说明请参考 [性能优化指南](./docs/OPTIMIZATION.md)。

## 开发计划

- [x] R2 Multipart Upload 分块上传
- [x] 智能重试机制
- [x] 完整监控系统
- [ ] 断点续传 UI
- [ ] 自定义过期时间
- [ ] 文件下载次数限制
- [ ] 文件预览功能
- [ ] 管理后台

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

MIT License

## 联系方式

如有问题或建议，请提交 Issue。

---

**注意**：本项目使用 Cloudflare 服务，部分功能可能产生费用。请参考 [Cloudflare 定价](https://www.cloudflare.com/plans/)。
