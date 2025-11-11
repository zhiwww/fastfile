# Cloudflare 日志和监控集成 - 快速开始

## 📊 概述

FastFile现在支持完整的结构化日志和性能监控功能，帮助您：
- 📝 追踪每个请求和上传会话
- 📈 监控性能指标和成功率
- 🔍 快速诊断问题
- 🚨 设置告警和通知

## 🚀 快速开始

### 1. 基础集成

最简单的方式，只需3个步骤：

```javascript
import { createLogger, generateRequestId, MetricsTracker } from './logger.js';

export default {
  async fetch(request, env, ctx) {
    const requestId = generateRequestId();
    const logger = createLogger(env);
    const metrics = new MetricsTracker();

    // ... 你的代码 ...

    // 输出指标
    ctx.waitUntil(metrics.flush(logger));
    return response;
  }
};
```

### 2. 查看日志

**本地开发**:
```bash
npm run dev
# 日志会输出到终端
```

**生产环境**:
```bash
# 实时查看日志
wrangler tail

# 过滤ERROR日志
wrangler tail --format json | jq 'select(.level == "ERROR")'

# 查找特定uploadId的日志
wrangler tail --format json | jq 'select(.uploadId == "abc123")'
```

### 3. 配置环境变量

```bash
# 设置日志级别
wrangler secret put LOG_LEVEL
# 输入: INFO (或 DEBUG, WARN, ERROR)

# 设置环境名称
wrangler secret put ENVIRONMENT
# 输入: production (或 staging, development)
```

## 📁 文件说明

| 文件 | 说明 |
|------|------|
| `src/logger.js` | 核心日志系统 - 包含Logger, MetricsTracker等类 |
| `src/index-monitored-example.js` | 完整集成示例 - 展示如何在实际代码中使用 |
| `MONITORING_GUIDE.md` | 详细指南 - 包含所有功能和配置说明 |

## 🎯 核心功能

### 1. 结构化日志

所有日志以JSON格式输出，易于查询：

```json
{
  "timestamp": "2025-11-11T15:30:45.123Z",
  "level": "INFO",
  "message": "Upload completed",
  "uploadId": "abc123",
  "duration": 12345,
  "chunks": {
    "total": 100,
    "uploaded": 100,
    "failed": 0,
    "retried": 3
  },
  "retryRate": "3.00%"
}
```

### 2. 性能指标

自动追踪关键指标：

| 指标 | 说明 |
|------|------|
| `request.total` | 总请求数 |
| `request.duration` | 请求延迟 |
| `upload.init` | 上传初始化次数 |
| `upload.complete` | 上传完成次数 |
| `chunk.success` | 成功上传的chunk数 |
| `chunk.failed` | 失败的chunk数 |
| `chunk.retried` | 重试的chunk数 |
| `retry.attempt` | 重试次数统计 |

### 3. 追踪器

三种追踪器覆盖不同场景：

**RequestTracker** - HTTP请求追踪
```javascript
const tracker = new RequestTracker(requestId, logger, metrics);
tracker.event('request.start');
// ... 处理请求 ...
tracker.finish(200);
```

**UploadSessionTracker** - 上传会话追踪
```javascript
const uploadTracker = new UploadSessionTracker(uploadId, logger, metrics);
uploadTracker.initUpload(filesCount, totalSize);
uploadTracker.chunkSuccess(index, size);
uploadTracker.complete(true);
```

**MetricsTracker** - 指标追踪
```javascript
metrics.increment('upload.init', 1);
metrics.timing('chunk.duration', 1234);
metrics.gauge('chunk.size', 10485760);
```

## 📊 监控仪表盘

### 关键指标

```
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ 总请求数         │  │ 平均延迟         │  │ 错误率           │
│ 1,234,567       │  │ 245ms           │  │ 0.05%           │
└─────────────────┘  └─────────────────┘  └─────────────────┘

┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ 上传成功率       │  │ Chunk重试率      │  │ P95延迟          │
│ 98.5%           │  │ 2.3%            │  │ 1.2s            │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

### 查询示例

**查找失败的上传**:
```bash
wrangler tail --format json | \
  jq 'select(.level == "ERROR" and .message == "Upload failed")'
```

**计算平均上传时间**:
```bash
wrangler tail --format json | \
  jq -s '[.[] | select(.message == "Upload completed") | .duration] | add / length'
```

**监控重试率**:
```bash
wrangler tail --format json | \
  jq 'select(.retryRate) | {uploadId, retryRate}'
```

## 🔧 高级功能

### 1. Logpush 配置

将日志推送到R2进行长期存储：

```bash
wrangler logpush create \
  --destination-conf "bucket=fastfile-logs" \
  --dataset=workers_trace_events \
  --filter='outcome!="ok"'
```

### 2. 日志采样

减少日志量，只记录10%的请求：

```javascript
if (Math.random() < 0.1) {
  logger.info('Sampled request', { requestId });
}
```

### 3. Grafana集成

配置Grafana Loki查询：

```promql
# 上传成功率
sum(rate(chunk_success_total[5m])) /
sum(rate(chunk_total[5m])) * 100

# P95延迟
histogram_quantile(0.95, rate(upload_duration_bucket[5m]))
```

## 🚨 告警配置

### Cloudflare Workers Analytics

1. Dashboard → Workers → Analytics
2. 配置告警规则：
   - 错误率 > 5%
   - P95延迟 > 10秒
   - CPU使用率 > 80%

### 推荐告警

| 指标 | 阈值 | 严重性 |
|------|------|--------|
| 错误率 | > 5% | HIGH |
| P95延迟 | > 10s | MEDIUM |
| 重试率 | > 20% | MEDIUM |
| 上传成功率 | < 90% | HIGH |

## 📚 相关文档

- 📘 [MONITORING_GUIDE.md](./MONITORING_GUIDE.md) - 完整监控指南
- 📄 [src/logger.js](./src/logger.js) - 日志系统源码
- 📝 [src/index-monitored-example.js](./src/index-monitored-example.js) - 集成示例

## ❓ 常见问题

**Q: 日志会影响性能吗？**
A: 影响很小。使用`ctx.waitUntil()`异步输出日志，不会阻塞请求。

**Q: 如何减少日志量？**
A: 提高`LOG_LEVEL`到WARN或ERROR，或使用采样。

**Q: 可以自定义指标吗？**
A: 可以！使用`metrics.increment()`、`metrics.gauge()`等方法。

**Q: 如何导出日志到第三方服务？**
A: 使用Cloudflare Logpush配置导出到S3、R2或Grafana Loki。

## 🎯 下一步

1. 阅读 [MONITORING_GUIDE.md](./MONITORING_GUIDE.md) 了解详细功能
2. 查看 [index-monitored-example.js](./src/index-monitored-example.js) 学习集成
3. 配置Logpush进行长期存储
4. 设置Grafana仪表盘
5. 配置告警通知

---

**版本**: 1.0.0
**更新时间**: 2025-11-11
**支持**: [GitHub Issues](https://github.com/zhiwww/fastfile/issues)
