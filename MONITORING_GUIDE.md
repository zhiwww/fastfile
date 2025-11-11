# Cloudflare 日志和监控集成指南

## 📊 概述

本指南介绍如何在FastFile中使用结构化日志和性能监控功能。

## 🎯 核心功能

### 1. 结构化日志
- JSON格式日志，易于查询和分析
- 多级别支持：DEBUG, INFO, WARN, ERROR, FATAL
- 自动添加时间戳和上下文信息
- 错误堆栈追踪

### 2. 性能指标
- 请求计数和延迟追踪
- 上传成功率统计
- Chunk重试率监控
- 自定义业务指标

### 3. 会话追踪
- 完整的上传会话追踪
- 请求级别追踪
- 事件时间线记录

## 📝 使用方法

### 基础日志使用

```javascript
import { createLogger } from './logger.js';

// 创建日志器
const logger = createLogger(env);

// 记录不同级别的日志
logger.info('Upload started', { uploadId: '123', fileCount: 5 });
logger.warn('Retry attempt', { attempt: 2, maxAttempts: 5 });
logger.error('Upload failed', { error: new Error('Network error') });
```

### 输出示例

```json
{
  "timestamp": "2025-11-11T15:30:45.123Z",
  "level": "INFO",
  "message": "Upload started",
  "environment": "production",
  "version": "1.0.0",
  "uploadId": "123",
  "fileCount": 5
}
```

### 请求追踪

```javascript
import { generateRequestId, RequestTracker, MetricsTracker } from './logger.js';

export default {
  async fetch(request, env, ctx) {
    const requestId = generateRequestId();
    const logger = createLogger(env);
    const metrics = new MetricsTracker();
    const tracker = new RequestTracker(requestId, logger, metrics);

    try {
      tracker.event('request.start', {
        method: request.method,
        path: new URL(request.url).pathname
      });

      // 处理请求...
      const response = await handleRequest(request, env, tracker);

      tracker.finish(response.status, {
        size: response.headers.get('content-length')
      });

      // 输出指标
      ctx.waitUntil(metrics.flush(logger));

      return response;
    } catch (error) {
      tracker.error(error);
      tracker.finish(500, { error: error.message });
      throw error;
    }
  }
};
```

### 上传会话追踪

```javascript
import { UploadSessionTracker } from './logger.js';

async function handleUploadInit(request, env, logger, metrics) {
  const { files, password } = await request.json();
  const uploadId = generateFileId();

  // 创建上传会话追踪器
  const uploadTracker = new UploadSessionTracker(uploadId, logger, metrics);
  uploadTracker.initUpload(files.length, getTotalSize(files));

  // 处理上传...
  for (const file of files) {
    try {
      await uploadChunk(file, uploadTracker);
      uploadTracker.chunkSuccess(chunkIndex, chunkSize);
    } catch (error) {
      uploadTracker.chunkFailure(chunkIndex, error);
    }
  }

  uploadTracker.complete(true);
}
```

## 📊 查看日志

### 1. 本地开发

使用`wrangler dev`时，日志会输出到终端：

```bash
npm run dev
```

### 2. 实时日志 (Tail)

查看生产环境实时日志：

```bash
wrangler tail
```

过滤特定级别：

```bash
# 只看ERROR日志
wrangler tail --format json | jq 'select(.level == "ERROR")'

# 只看特定uploadId的日志
wrangler tail --format json | jq 'select(.uploadId == "abc123")'
```

### 3. Cloudflare Dashboard

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 选择你的Worker
3. 点击 **Logs** → **Logpush**
4. 配置日志目的地（S3, R2, 或其他服务）

### 4. Logpush 配置

将日志推送到R2进行长期存储：

```bash
# 创建Logpush任务
wrangler logpush create \
  --destination-conf "bucket=fastfile-logs" \
  --dataset=workers_trace_events \
  --filter='outcome!="ok"'  # 只记录错误
```

## 📈 性能指标

### 可用指标

| 指标名称 | 类型 | 说明 |
|---------|------|------|
| `request.total` | Counter | 总请求数 |
| `request.duration` | Timing | 请求延迟 |
| `request.errors` | Counter | 错误总数 |
| `upload.init` | Counter | 上传初始化次数 |
| `upload.complete` | Counter | 上传完成次数 |
| `upload.duration` | Timing | 上传总时长 |
| `chunk.success` | Counter | 成功上传的chunk数 |
| `chunk.failed` | Counter | 失败的chunk数 |
| `chunk.retried` | Counter | 重试的chunk数 |
| `chunk.size` | Gauge | Chunk大小 |

### 查询示例

```bash
# 查看过去1小时的指标
wrangler tail --format json | \
  jq 'select(.metrics) | .metrics[] | select(.name == "upload.duration")'

# 计算平均上传时间
wrangler tail --format json | \
  jq -s '[.[] | select(.metrics) | .metrics[] |
         select(.name == "upload.duration") | .value] |
         add / length'
```

## 🔍 监控查询示例

### 错误率监控

```javascript
// 查找失败的上传
{
  "level": "ERROR",
  "message": "Upload failed",
  "uploadId": "*"
}
```

### 重试率监控

```javascript
// 查找需要重试的chunk
{
  "message": "Chunk upload failed",
  "retryCount": ">0"
}
```

### 慢请求监控

```javascript
// 查找超过10秒的请求
{
  "message": "Request completed",
  "duration": ">10000"
}
```

## 🚨 告警配置

### Cloudflare Workers Analytics

1. 进入 Worker → Analytics
2. 配置告警规则：
   - 错误率 > 5%
   - P95延迟 > 10秒
   - 请求量突增

### 使用Grafana Cloud

1. 配置Logpush到Grafana Loki
2. 创建Dashboard监控关键指标
3. 设置告警通知

示例Grafana查询：

```promql
# 上传成功率
sum(rate(chunk_success_total[5m])) /
sum(rate(chunk_total[5m])) * 100

# P95上传延迟
histogram_quantile(0.95,
  rate(upload_duration_bucket[5m]))

# 错误率
sum(rate(request_errors_total[5m])) /
sum(rate(request_total[5m])) * 100
```

## 🎛️ 环境变量配置

在`.dev.vars`或wrangler secrets中配置：

```bash
# 日志级别 (DEBUG, INFO, WARN, ERROR, FATAL)
LOG_LEVEL=INFO

# 环境名称
ENVIRONMENT=production

# 版本号
VERSION=1.0.0

# 设置secrets
wrangler secret put LOG_LEVEL
# 输入: INFO

wrangler secret put ENVIRONMENT
# 输入: production
```

## 📊 仪表盘示例

### 关键指标卡片

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

### 趋势图

```
上传成功率 (24小时)
100% ┤                                    ╭─╮
 95% ┤                         ╭─╮      ╭─╯ ╰─╮
 90% ┤              ╭─────────╯ ╰──────╯      ╰──
 85% ┤     ╭────────╯
 80% ┼─────╯
     └────────────────────────────────────────────
      0h   4h   8h   12h  16h  20h  24h
```

## 🔧 故障排查

### 常见问题

**1. 日志没有输出**
- 检查`LOG_LEVEL`设置
- 确认`wrangler.toml`中没有禁用日志
- 使用`wrangler tail`查看实时日志

**2. 指标不准确**
- 确认`ctx.waitUntil()`正确使用
- 检查指标flush是否被调用
- 验证时间戳格式正确

**3. 日志太多**
- 提高`LOG_LEVEL`到WARN或ERROR
- 使用采样（只记录10%的请求）
- 配置Logpush过滤器

### 性能优化

```javascript
// 采样：只记录10%的请求
if (Math.random() < 0.1) {
  logger.info('Sampled request', { requestId });
}

// 异步日志输出
ctx.waitUntil((async () => {
  metrics.flush(logger);
})());
```

## 📚 相关资源

- [Cloudflare Workers Analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)
- [Logpush Documentation](https://developers.cloudflare.com/logs/logpush/)
- [Workers Trace Events](https://developers.cloudflare.com/logs/reference/log-fields/account/workers_trace_events/)
- [Grafana Loki Integration](https://grafana.com/docs/loki/latest/)

---

**更新时间**: 2025-11-11
**版本**: 1.0.0
