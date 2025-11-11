# FastFile 监控系统文档

完整的日志、监控和追踪系统指南。

## 目录

- [快速开始](#快速开始)
- [日志系统](#日志系统)
- [监控指标](#监控指标)
- [追踪器](#追踪器)
- [集成示例](#集成示例)
- [查询示例](#查询示例)
- [告警配置](#告警配置)
- [故障排查](#故障排查)

## 快速开始

### 5分钟集成

**1. 基础导入**

```javascript
import { createLogger, generateRequestId, MetricsTracker } from './logger.js';

export default {
  async fetch(request, env, ctx) {
    const requestId = generateRequestId();
    const logger = createLogger(env);
    const metrics = new MetricsTracker();

    // 你的业务逻辑...

    // 输出指标
    ctx.waitUntil(metrics.flush(logger));
    return response;
  }
};
```

**2. 查看日志**

```bash
# 本地开发
npm run dev

# 生产环境实时日志
wrangler tail

# 过滤ERROR日志
wrangler tail --format json | jq 'select(.level == "ERROR")'
```

**3. 配置环境变量**

```bash
# 设置日志级别
wrangler secret put LOG_LEVEL
# 输入: INFO (或 DEBUG, WARN, ERROR)

# 设置环境名称
wrangler secret put ENVIRONMENT
# 输入: production
```

## 日志系统

### 核心功能

**结构化日志**
- JSON 格式输出，易于查询和分析
- 多级别支持：DEBUG, INFO, WARN, ERROR, FATAL
- 自动添加时间戳和上下文信息
- 错误堆栈追踪

**日志级别**

| 级别 | 用途 | 示例 |
|------|------|------|
| DEBUG | 调试信息 | 详细的执行流程 |
| INFO | 常规信息 | 请求开始/完成 |
| WARN | 警告信息 | 重试操作 |
| ERROR | 错误信息 | 上传失败 |
| FATAL | 致命错误 | 系统崩溃 |

### 使用方法

**基础日志**

```javascript
import { createLogger } from './logger.js';

const logger = createLogger(env);

// 记录不同级别的日志
logger.info('Upload started', { uploadId: '123', fileCount: 5 });
logger.warn('Retry attempt', { attempt: 2, maxAttempts: 5 });
logger.error('Upload failed', { error: new Error('Network error') });
```

**子日志器（继承上下文）**

```javascript
// 创建带上下文的子日志器
const uploadLogger = logger.child({
  uploadId: 'abc123',
  handler: 'upload'
});

uploadLogger.info('Processing chunk', { chunkIndex: 1 });
// 输出包含 uploadId 和 handler 上下文
```

**日志输出格式**

```json
{
  "timestamp": "2025-11-11T15:30:45.123Z",
  "level": "INFO",
  "message": "Upload completed",
  "environment": "production",
  "version": "1.0.0",
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

### 错误日志

```javascript
try {
  await uploadFile();
} catch (error) {
  logger.error('Upload failed', {
    error,  // 自动序列化错误对象
    uploadId,
    chunkIndex
  });
}
```

**错误输出包含**：
- 错误名称
- 错误消息
- 完整堆栈信息

## 监控指标

### 可用指标

| 指标名称 | 类型 | 说明 | 标签 |
|---------|------|------|------|
| `request.total` | Counter | 总请求数 | status |
| `request.duration` | Timing | 请求延迟(ms) | status |
| `request.errors` | Counter | 错误总数 | error_type |
| `upload.init` | Counter | 上传初始化次数 | - |
| `upload.complete` | Counter | 上传完成次数 | success |
| `upload.duration` | Timing | 上传总时长(ms) | - |
| `chunk.success` | Counter | 成功上传的chunk数 | - |
| `chunk.failed` | Counter | 失败的chunk数 | error |
| `chunk.retried` | Counter | 重试的chunk数 | - |
| `chunk.size` | Gauge | Chunk大小(bytes) | - |

### 使用方法

**MetricsTracker**

```javascript
import { MetricsTracker } from './logger.js';

const metrics = new MetricsTracker();

// Counter - 计数器
metrics.increment('upload.init', 1);
metrics.increment('chunk.success', 1);

// Timing - 时间测量
metrics.timing('request.duration', 1234, { status: 200 });
metrics.timing('upload.duration', 12345);

// Gauge - 测量值
metrics.gauge('chunk.size', 10485760);  // 10MB

// 输出指标（异步，不阻塞请求）
ctx.waitUntil(metrics.flush(logger));
```

**指标输出格式**

```json
{
  "timestamp": "2025-11-11T16:09:17.422Z",
  "level": "INFO",
  "message": "Metrics report",
  "metrics": [
    {
      "name": "request.duration",
      "tags": { "status": 200 },
      "value": 2,
      "type": "timing",
      "unit": "ms"
    },
    {
      "name": "request.total",
      "tags": { "status": 200 },
      "value": 1,
      "type": "counter"
    }
  ]
}
```

## 追踪器

### RequestTracker - HTTP请求追踪

追踪整个请求的生命周期。

```javascript
import { RequestTracker } from './logger.js';

const tracker = new RequestTracker(requestId, logger, metrics);

// 记录事件
tracker.event('request.start', {
  method: request.method,
  path: new URL(request.url).pathname
});

tracker.event('validation.complete', { valid: true });

// 记录错误
tracker.error(new Error('Something went wrong'));

// 完成请求
tracker.finish(200, {
  handler: 'upload-page',
  bytes: 12345
});
```

### UploadSessionTracker - 上传会话追踪

追踪完整的上传会话，包括所有chunks。

```javascript
import { UploadSessionTracker } from './logger.js';

const uploadTracker = new UploadSessionTracker(uploadId, logger, metrics);

// 初始化上传
uploadTracker.initUpload(filesCount, totalSize);

// 记录chunk成功
uploadTracker.chunkSuccess(chunkIndex, chunkSize);

// 记录chunk失败
uploadTracker.chunkFailure(chunkIndex, error);

// 完成上传
uploadTracker.complete(true, {
  fileId: 'xyz789',
  compressedSize: 98765
});
```

### 追踪器输出

**请求完成日志**：
```json
{
  "timestamp": "2025-11-11T16:09:17.410Z",
  "level": "INFO",
  "message": "Request completed",
  "requestId": "req_1762877357408_p3jk33ng74t",
  "statusCode": 200,
  "duration": 2,
  "events": 1,
  "handler": "upload-page"
}
```

**上传完成日志**：
```json
{
  "timestamp": "2025-11-11T16:10:23.567Z",
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

## 集成示例

### 完整的Worker集成

```javascript
import { createLogger, generateRequestId, MetricsTracker, RequestTracker } from './logger.js';

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

      const response = await handleRequest(request, env, logger, metrics);

      tracker.finish(response.status, {
        handler: 'main',
        size: response.headers.get('content-length')
      });

      ctx.waitUntil(metrics.flush(logger));

      return response;
    } catch (error) {
      tracker.error(error);
      tracker.finish(500, { error: error.message });

      logger.error('Request failed', { error, requestId });

      return new Response('Internal Server Error', { status: 500 });
    }
  }
};
```

### 上传处理器集成

```javascript
async function handleUploadInit(request, env, logger, metrics) {
  const { files, password } = await request.json();
  const uploadId = generateFileId();

  // 创建上传追踪器
  const uploadLogger = logger.child({ uploadId, handler: 'upload-init' });
  const uploadTracker = new UploadSessionTracker(uploadId, uploadLogger, metrics);

  uploadTracker.initUpload(files.length, getTotalSize(files));

  try {
    // 处理上传...
    const result = await processUpload(uploadId, files, password, env);

    uploadTracker.complete(true, { fileId: result.fileId });

    return jsonResponse({ success: true, uploadId });
  } catch (error) {
    uploadTracker.complete(false, { error: error.message });
    throw error;
  }
}
```

## 查询示例

### 实时日志查询

**查找失败的上传**

```bash
wrangler tail --format json | \
  jq 'select(.level == "ERROR" and .message == "Upload failed")'
```

**查找特定uploadId的日志**

```bash
wrangler tail --format json | \
  jq 'select(.uploadId == "abc123")'
```

**计算平均上传时间**

```bash
wrangler tail --format json | \
  jq -s '[.[] | select(.message == "Upload completed") | .duration] | add / length'
```

**监控重试率**

```bash
wrangler tail --format json | \
  jq 'select(.retryRate) | {uploadId, retryRate, chunks}'
```

**查看所有ERROR日志**

```bash
wrangler tail --format json | jq 'select(.level == "ERROR")'
```

### 指标查询

**查看请求延迟**

```bash
wrangler tail --format json | \
  jq 'select(.metrics) | .metrics[] | select(.name == "request.duration")'
```

**统计上传成功率**

```bash
wrangler tail --format json | \
  jq -s '[.[] | select(.metrics) | .metrics[] |
         select(.name == "upload.complete")] |
         group_by(.tags.success) |
         map({success: .[0].tags.success, count: length})'
```

### Logpush配置

将日志推送到R2进行长期存储：

```bash
wrangler logpush create \
  --destination-conf "bucket=fastfile-logs" \
  --dataset=workers_trace_events \
  --filter='outcome!="ok"'  # 只记录错误
```

## 告警配置

### Cloudflare Workers Analytics

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 选择你的Worker
3. 点击 **Analytics**
4. 配置告警规则：

| 指标 | 阈值 | 严重性 |
|------|------|--------|
| 错误率 | > 5% | HIGH |
| P95延迟 | > 10s | MEDIUM |
| CPU使用率 | > 80% | MEDIUM |
| 内存使用率 | > 90% | HIGH |

### 推荐告警规则

**上传失败率告警**

```javascript
// 查询条件
{
  "message": "Upload completed",
  "chunks.failed": ">0"
}

// 阈值：失败率 > 10%
```

**慢请求告警**

```javascript
// 查询条件
{
  "message": "Request completed",
  "duration": ">10000"  // 超过10秒
}

// 阈值：慢请求数 > 100/小时
```

**重试率告警**

```javascript
// 查询条件
{
  "retryRate": ">20%"
}

// 阈值：重试率过高
```

### Grafana集成

**Loki查询示例**

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

**Dashboard配置**

创建以下面板：
1. 请求总量趋势图
2. 错误率趋势图
3. P95/P99延迟图
4. 上传成功率图
5. Chunk重试率图

## 故障排查

### 常见问题

**1. 日志没有输出**

检查项：
- 确认 `LOG_LEVEL` 设置正确
- 使用 `wrangler tail` 查看实时日志
- 检查 `wrangler.toml` 中是否禁用日志

解决方法：
```bash
# 查看当前日志级别
wrangler secret list

# 设置日志级别
wrangler secret put LOG_LEVEL
# 输入: DEBUG
```

**2. 指标不准确**

检查项：
- 确认 `ctx.waitUntil()` 正确使用
- 检查 `metrics.flush()` 是否被调用
- 验证时间戳格式正确

解决方法：
```javascript
// 确保在返回响应前调用
ctx.waitUntil(metrics.flush(logger));
return response;
```

**3. 日志太多**

检查项：
- 当前日志级别是否太低（DEBUG）
- 是否在循环中记录日志
- 是否有大量重复日志

解决方法：
```javascript
// 提高日志级别
wrangler secret put LOG_LEVEL
# 输入: WARN 或 ERROR

// 使用采样（只记录10%的请求）
if (Math.random() < 0.1) {
  logger.info('Sampled request', { requestId });
}
```

**4. 重试日志太多**

说明：
- 网络环境不稳定
- 需要调整重试配置

解决方法：
- 降低并发数：`MAX_CONCURRENT = 2`
- 减小chunk大小：`CHUNK_SIZE = 5MB`
- 增加重试间隔

### 性能优化

**日志采样**

```javascript
// 只采样10%的成功请求，所有错误请求都记录
const shouldLog = level >= LogLevel.WARN || Math.random() < 0.1;

if (shouldLog) {
  logger.info('Request completed', { requestId, duration });
}
```

**异步日志输出**

```javascript
// 使用 waitUntil 避免阻塞请求
ctx.waitUntil((async () => {
  await metrics.flush(logger);
  // 其他异步操作...
})());
```

**批量指标收集**

```javascript
// 收集多个指标后一次性输出
const metrics = new MetricsTracker();

for (const chunk of chunks) {
  metrics.increment('chunk.success', 1);
  metrics.gauge('chunk.size', chunk.size);
}

// 一次性输出所有指标
ctx.waitUntil(metrics.flush(logger));
```

## 监控仪表盘

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

## 相关资源

- [Cloudflare Workers Analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)
- [Logpush Documentation](https://developers.cloudflare.com/logs/logpush/)
- [Workers Trace Events](https://developers.cloudflare.com/logs/reference/log-fields/account/workers_trace_events/)
- [Grafana Loki Integration](https://grafana.com/docs/loki/latest/)

## 测试结果

监控系统已在本地环境测试通过：

- 结构化日志输出正常
- 请求追踪功能正常
- 指标收集和输出正常
- 异步flush不阻塞请求
- 性能开销小于2ms

详细测试结果请参考项目根目录的测试脚本。

---

**版本**: 1.0.0
**更新时间**: 2025-11-12
**维护者**: FastFile Team
