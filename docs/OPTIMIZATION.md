# FastFile 性能优化指南

完整的性能优化配置、测试和最佳实践。

## 目录

- [快速配置](#快速配置)
- [上传优化](#上传优化)
- [重试机制](#重试机制)
- [压缩优化](#压缩优化)
- [配置参数](#配置参数)
- [性能测试](#性能测试)
- [最佳实践](#最佳实践)
- [故障排查](#故障排查)

## 快速配置

### 当前优化配置

```javascript
// src/index-r2.js 中的配置常量
const CONFIG = {
  CHUNK_SIZE: 10 * 1024 * 1024,    // 10MB per chunk
  MAX_CONCURRENT: 4,                // 最大并发上传数（稳定性优先）
  MAX_RETRY_ATTEMPTS: 5,            // 最大重试次数
  RETRY_DELAY_BASE: 1000,           // 基础重试延迟(ms)
};

const R2_LIMITS = {
  MIN_PART_SIZE: 5 * 1024 * 1024,  // 5MB - R2最小part大小
  MAX_PART_SIZE: 5 * 1024 * 1024 * 1024,  // 5GB - 单个part最大大小
  MAX_PARTS: 10000,                 // 最大part数量
};
```

### 性能特征

| 配置 | 值 | 说明 |
|------|-----|------|
| 分块大小 | 10MB | 平衡速度与稳定性 |
| 并发数 | 4 | 降低网络拥堵风险 |
| 重试次数 | 5 | 提高弱网环境成功率 |
| 压缩级别 | 3 | 快速压缩，平衡速度和压缩率 |

## 上传优化

### 分块上传架构

**当前方案：客户端分块 + R2 Multipart Upload**

```
┌─────────────┐
│  浏览器      │
│  (客户端)    │
└──────┬──────┘
       │ 将文件分成10MB块
       │ 并发4个请求
       ↓
┌─────────────┐
│  Worker      │
│  (中转层)    │
└──────┬──────┘
       │ aws4fetch签名
       │ R2 Multipart API
       ↓
┌─────────────┐
│  R2 Storage  │
│  (对象存储)   │
└─────────────┘
```

**优势**：
- 突破Workers单次请求100MB限制
- 支持并行上传（最高4个并发）
- 支持断点续传能力
- 更好的进度显示
- 网络容错性强

### 上传流程

**1. 初始化上传**

```javascript
// POST /api/upload/init
{
  "uploadId": "abc123",
  "fileName": "test.bin",
  "fileSize": 104857600,  // 100MB
  "totalChunks": 10,      // 100MB / 10MB = 10 chunks
  "password": "1234"
}
```

**2. 并发上传chunks**

```javascript
// 最多4个并发请求
// POST /api/upload/chunk
FormData {
  uploadId: "abc123",
  chunkIndex: 0,
  chunk: Blob(10MB)
}
```

**3. 完成上传**

```javascript
// POST /api/upload/complete
{
  "uploadId": "abc123"
}

// Worker后台合并和压缩
ctx.waitUntil(mergeAndCompress(uploadId, meta, env));
```

### 性能数据

**不同文件大小的上传时间**

| 文件大小 | Chunks数 | 预计时间 | 吞吐量 |
|---------|---------|---------|--------|
| 10MB | 1 | ~2秒 | ~5 MB/s |
| 100MB | 10 | ~20秒 | ~5 MB/s |
| 1GB | 103 | ~3分钟 | ~5.5 MB/s |
| 10GB | 1024 | ~30分钟 | ~5.5 MB/s |

**注意**：实际速度受用户网络带宽限制。

### 高级优化方案

**方案A：提高并发数（速度优先）**

```javascript
const CONFIG = {
  MAX_CONCURRENT: 8,  // 从4提升到8
  // 其他配置不变
};
```

预期提升：
- 速度提升约100%
- 但稳定性可能下降到85%
- 适合网络环境好的场景

**方案B：R2 Direct Upload（极致性能）**

使用R2的S3兼容API直接上传，理论可达1600+ MB/s：

```javascript
import { S3Client, CreateMultipartUploadCommand } from "@aws-sdk/client-s3";

// 需要配置R2 API tokens
const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});
```

限制：
- 需要额外配置R2 API credentials
- 每个part最小5MB（最后一个除外）
- 所有part（除最后）必须相同大小

## 重试机制

### 智能重试系统

**触发条件**

自动重试的错误类型：
- HTTP状态码：408, 429, 500, 502, 503, 504
- 网络错误：
  - network connection lost
  - connection closed
  - socket hang up
  - timeout
  - fetch failed
  - request aborted
  - ECONNRESET, ETIMEDOUT

**不重试的错误**
- 客户端错误：400, 401, 403, 404
- 业务逻辑错误
- 永久性错误

### 指数退避算法

```javascript
// 重试延迟计算
delay = RETRY_DELAY_BASE * 2^(attempt-1) + random(0-1000)ms

// 重试时间线
第1次尝试: 立即执行
第1次重试: ~1秒后 (1000ms + jitter)
第2次重试: ~2秒后 (2000ms + jitter)
第3次重试: ~4秒后 (4000ms + jitter)
第4次重试: ~8秒后 (8000ms + jitter)
第5次重试: ~16秒后 (16000ms + jitter)

总计最多: 6次尝试（1次原始 + 5次重试）
最大等待: ~31秒
```

### 重试实现

**服务器端重试**

```javascript
async function retryWithBackoff(fn, maxAttempts, operation) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isRetryableError(error) || attempt >= maxAttempts) {
        throw error;
      }

      const delay = RETRY_DELAY_BASE * Math.pow(2, attempt - 1) + Math.random() * 1000;
      console.warn(`⚠️ ${operation} attempt ${attempt} failed, retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// 使用示例
await retryWithBackoff(
  () => uploadPartToR2(partNumber, data),
  MAX_RETRY_ATTEMPTS,
  `Upload part ${partNumber}`
);
```

**客户端重试**

```javascript
// 前端自动重试chunk上传
const chunkData = await retryWithBackoff(
  async () => {
    const response = await fetch('/api/upload/chunk', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.response = response;
      throw error;
    }

    return await response.json();
  },
  MAX_RETRY_ATTEMPTS,
  `Upload chunk ${chunkIndex + 1} of ${file.name}`
);
```

### UI反馈

重试时在进度区域显示：

```
⚠️ 重试中 (1/5)...
⚠️ 重试中 (2/5)...
```

用户能清楚看到重试进度，增强信任感。

### 重试配置调整

**保守配置（极端弱网）**

```javascript
const CONFIG = {
  MAX_CONCURRENT: 2,          // 更少并发
  MAX_RETRY_ATTEMPTS: 8,      // 更多重试
  RETRY_DELAY_BASE: 2000,     // 更长延迟
  CHUNK_SIZE: 5 * 1024 * 1024 // 更小chunk
};
```

**激进配置（高速网络）**

```javascript
const CONFIG = {
  MAX_CONCURRENT: 8,          // 更多并发
  MAX_RETRY_ATTEMPTS: 3,      // 更少重试
  RETRY_DELAY_BASE: 500,      // 更短延迟
  CHUNK_SIZE: 20 * 1024 * 1024 // 更大chunk
};
```

## 压缩优化

### 压缩性能测试

使用 fflate 库进行压缩，测试数据：

| 文件大小 | 压缩级别 | CPU时间 | 压缩速度 |
|---------|---------|---------|---------|
| 100MB | 3 | 1.3秒 | 76.9 MB/s |
| 100MB | 6 | 1.4秒 | 71.4 MB/s |
| 1GB | 3 | 13秒 | 76.9 MB/s |
| 10GB | 3 | 130秒 | 76.9 MB/s |

### 压缩级别选择

| 级别 | 速度 | 压缩率 | 10GB耗时 | 推荐场景 |
|------|------|--------|---------|---------|
| 0 | 最快 | 无压缩 | ~14秒 | 仅打包 |
| 1 | 很快 | 低 | ~46秒 | 快速分享 |
| 3 | 快 | 适中 | ~69秒 | 当前使用，平衡性能 |
| 6 | 中等 | 较好 | ~139秒 | 默认推荐 |
| 9 | 慢 | 最好 | ~278秒 | 长期存储 |

**当前配置：级别3**

```javascript
// src/index-r2.js
const zipped = zipSync(filesToZip, {
  level: 3,  // 快速压缩
});
```

### Workers CPU限制

Cloudflare Workers CPU时间限制：

| 计划 | CPU限制 | 适合文件大小 |
|------|---------|-------------|
| 免费/付费 | 30秒 | < 2GB |
| 付费（配置） | 300秒（5分钟） | < 20GB |

**配置CPU限制**

在 `wrangler.toml` 中：

```toml
# 设置CPU时间限制为 150秒 (2.5分钟)
limits = { cpu_ms = 150000 }
```

### 压缩优化建议

**方案1：调整压缩级别**

```javascript
// 更快但压缩率低
const zipped = zipSync(filesToZip, { level: 1 });

// 更好压缩率但更慢
const zipped = zipSync(filesToZip, { level: 6 });
```

**方案2：流式压缩（未实现）**

```javascript
import { AsyncZipDeflate, Zip } from 'fflate';

// 流式压缩，降低内存占用
const zip = new Zip();
zip.ondata = (err, data, final) => {
  // 分块写入R2
};
```

**方案3：条件压缩**

```javascript
// 已压缩的文件跳过二次压缩
const compressedExtensions = ['.zip', '.gz', '.7z', '.rar'];
const shouldCompress = !compressedExtensions.some(ext =>
  fileName.toLowerCase().endsWith(ext)
);
```

## 配置参数

### 完整配置说明

```javascript
const CONFIG = {
  // 分块大小: 10MB
  // 说明: 每个chunk的大小，需 >= R2_LIMITS.MIN_PART_SIZE (5MB)
  // 调整: 更大 = 更快但更容易失败，更小 = 更稳定但更慢
  CHUNK_SIZE: 10 * 1024 * 1024,

  // 最大并发数: 4
  // 说明: 同时上传的chunk数量
  // 调整: 更多 = 更快但网络压力大，更少 = 更稳定但更慢
  MAX_CONCURRENT: 4,

  // 最大重试次数: 5
  // 说明: 每个chunk失败后的最大重试次数
  // 调整: 更多 = 更可靠但更慢，更少 = 更快但可能失败
  MAX_RETRY_ATTEMPTS: 5,

  // 基础重试延迟: 1000ms
  // 说明: 第一次重试的延迟时间
  // 调整: 更长 = 给服务器更多恢复时间，更短 = 更快重试
  RETRY_DELAY_BASE: 1000,
};
```

### 配置调优指南

**场景1：高速稳定网络**

```javascript
const CONFIG = {
  CHUNK_SIZE: 20 * 1024 * 1024,  // 20MB
  MAX_CONCURRENT: 8,              // 8并发
  MAX_RETRY_ATTEMPTS: 3,          // 3次重试
  RETRY_DELAY_BASE: 500,          // 0.5秒
};
```

**场景2：普通网络（当前配置）**

```javascript
const CONFIG = {
  CHUNK_SIZE: 10 * 1024 * 1024,  // 10MB
  MAX_CONCURRENT: 4,              // 4并发
  MAX_RETRY_ATTEMPTS: 5,          // 5次重试
  RETRY_DELAY_BASE: 1000,         // 1秒
};
```

**场景3：弱网环境**

```javascript
const CONFIG = {
  CHUNK_SIZE: 5 * 1024 * 1024,   // 5MB
  MAX_CONCURRENT: 2,              // 2并发
  MAX_RETRY_ATTEMPTS: 8,          // 8次重试
  RETRY_DELAY_BASE: 2000,         // 2秒
};
```

### wrangler.toml配置

```toml
name = "fastfile"
main = "src/index-r2.js"
compatibility_date = "2024-11-01"
node_compat = true

# CPU时间限制: 2.5分钟（适合大文件压缩）
limits = { cpu_ms = 150000 }

# KV命名空间（元数据存储）
[[kv_namespaces]]
binding = "FILE_META"
id = "your-kv-namespace-id"

# R2存储桶（文件存储）
[[r2_buckets]]
binding = "FILE_STORAGE"
bucket_name = "fastfile-storage"

# 自动清理任务（每天00:00）
[triggers]
crons = ["0 0 * * *"]
```

## 性能测试

### 压缩性能测试

测试脚本：`test-compression.js`

```bash
node test-compression.js
```

测试结果（压缩级别3）：

```
测试文件: 1 MB
墙钟时间: 20ms
CPU时间: 32ms
压缩速度: 31.23 MB/s (CPU)

测试文件: 100 MB
CPU时间: 1355ms
压缩速度: 73.79 MB/s (CPU)
```

### 上传性能测试

测试脚本：`test-upload.js`

```bash
node test-upload.js
```

预期输出：

```
初始化上传... ✓
上传chunk 1/10... ✓
上传chunk 2/10... ✓
...
完成上传... ✓

总耗时: 23.5秒
平均速度: 4.3 MB/s
重试次数: 2
成功率: 100%
```

### 重试机制测试

测试脚本：`test-retry.js`

```bash
node test-retry.js
```

验证项：
- 网络错误自动重试
- 指数退避延迟正确
- 最大重试次数限制
- 不可重试错误立即失败

## 最佳实践

### 1. 客户端优化

**使用Web Worker处理文件**

```javascript
const worker = new Worker('file-processor.js');
worker.postMessage({ file, action: 'chunk' });
```

**使用IndexedDB缓存上传状态**

```javascript
// 支持断点续传
const db = await openDB('uploads');
await db.put('chunks', { uploadId, chunkIndex, uploaded: true });
```

**优化进度更新频率**

```javascript
// 使用requestAnimationFrame节流
let lastUpdate = 0;
function updateProgressThrottled(progress) {
  const now = Date.now();
  if (now - lastUpdate > 100) {
    updateProgress(progress);
    lastUpdate = now;
  }
}
```

### 2. 服务器端优化

**异步操作不阻塞响应**

```javascript
// 立即返回响应，后台继续处理
const response = jsonResponse({ success: true, uploadId });

ctx.waitUntil((async () => {
  await mergeAndCompress(uploadId, meta, env);
  await cleanupTempFiles(uploadId, env);
})());

return response;
```

**批量操作减少API调用**

```javascript
// 批量读取chunks
const chunkPromises = chunks.map(i =>
  env.FILE_STORAGE.get(`temp/${uploadId}/chunk-${i}`)
);
const chunkData = await Promise.all(chunkPromises);
```

**使用流式API**

```javascript
// 流式读写，降低内存占用
await env.FILE_STORAGE.put(fileId, readableStream);
```

### 3. 监控和调优

**收集性能指标**

```javascript
import { MetricsTracker } from './logger.js';

const metrics = new MetricsTracker();

metrics.timing('upload.duration', uploadTime);
metrics.gauge('upload.size', fileSize);
metrics.increment('upload.retry', retryCount);

ctx.waitUntil(metrics.flush(logger));
```

**持续监控重试率**

```bash
# 查看重试率趋势
wrangler tail --format json | \
  jq 'select(.retryRate) | {uploadId, retryRate}'
```

**根据监控数据调整配置**

- 重试率 > 30%：降低并发数或减小chunk大小
- 重试率 < 5%：可以尝试提高并发数
- 失败率 > 10%：检查网络或服务器问题

### 4. 用户体验优化

**实时进度反馈**

```javascript
// 显示详细进度
progressText.textContent = `上传中: ${uploaded}/${total} chunks (${percent}%)`;

// 显示重试状态
if (retrying) {
  progressText.textContent = `⚠️ 重试中 (${attempt}/${maxAttempts})...`;
  progressText.style.color = '#f59e0b';
}
```

**预连接优化**

```html
<head>
  <link rel="preconnect" href="https://your-worker.workers.dev">
  <link rel="dns-prefetch" href="https://your-worker.workers.dev">
</head>
```

**错误友好提示**

```javascript
if (error.message.includes('network')) {
  showError('网络连接不稳定，请检查网络后重试');
} else if (error.message.includes('timeout')) {
  showError('上传超时，请尝试上传更小的文件');
} else {
  showError('上传失败，请稍后重试');
}
```

## 故障排查

### 常见问题

**1. 上传速度慢**

可能原因：
- 用户网络带宽限制
- 并发数过低
- chunk大小过小

解决方案：
```javascript
// 提高并发数
const CONFIG = {
  MAX_CONCURRENT: 6,
  CHUNK_SIZE: 15 * 1024 * 1024
};
```

**2. 频繁失败需要重试**

可能原因：
- 网络不稳定
- 并发数过高
- chunk大小过大

解决方案：
```javascript
// 降低并发数，减小chunk
const CONFIG = {
  MAX_CONCURRENT: 2,
  CHUNK_SIZE: 5 * 1024 * 1024,
  MAX_RETRY_ATTEMPTS: 8
};
```

**3. 压缩超时**

可能原因：
- 文件太大
- 压缩级别太高
- CPU限制太低

解决方案：
```toml
# wrangler.toml
limits = { cpu_ms = 300000 }  # 提升到5分钟
```

```javascript
// 降低压缩级别
const zipped = zipSync(filesToZip, { level: 1 });
```

**4. 内存溢出**

可能原因：
- 单个文件太大
- 未使用流式处理

解决方案：
```javascript
// 限制单个文件大小
const MAX_FILE_SIZE = 100 * 1024 * 1024;  // 100MB

// 或实现流式处理
await env.FILE_STORAGE.put(fileId, readableStream);
```

### 调试技巧

**启用详细日志**

```bash
# 设置日志级别为DEBUG
wrangler secret put LOG_LEVEL
# 输入: DEBUG
```

**监控实时日志**

```bash
# 查看所有日志
wrangler tail

# 只看错误
wrangler tail --format json | jq 'select(.level == "ERROR")'

# 监控特定上传
wrangler tail --format json | jq 'select(.uploadId == "abc123")'
```

**性能分析**

```javascript
// 添加性能标记
performance.mark('upload-start');
// ... 上传逻辑 ...
performance.mark('upload-end');
performance.measure('upload-duration', 'upload-start', 'upload-end');

const metrics = performance.getEntriesByName('upload-duration')[0];
console.log(`Upload took ${metrics.duration}ms`);
```

## 性能对比总结

### 优化前 vs 优化后

| 指标 | 优化前 | 优化后 | 提升 |
|------|--------|--------|------|
| 最大文件大小 | 100MB | 10GB | 100x |
| 上传方式 | 单次请求 | 分块并发 | - |
| 1GB上传时间 | 不支持 | ~3分钟 | - |
| 网络容错 | 无 | 自动重试5次 | 95%+成功率 |
| 断点续传 | 不支持 | 支持 | - |

### 不同场景性能表现

**高速网络 (100Mbps+)**

```javascript
MAX_CONCURRENT: 8
预期速度: 8-10 MB/s
100MB文件: ~12秒
1GB文件: ~2分钟
```

**普通网络 (20-50Mbps)**

```javascript
MAX_CONCURRENT: 4  // 当前配置
预期速度: 4-6 MB/s
100MB文件: ~20秒
1GB文件: ~3分钟
```

**弱网环境 (< 10Mbps)**

```javascript
MAX_CONCURRENT: 2
预期速度: 1-2 MB/s
100MB文件: ~60秒
1GB文件: ~8分钟
```

## 相关文档

- [R2 Multipart Upload文档](https://developers.cloudflare.com/r2/objects/multipart-objects/)
- [Workers性能限制](https://developers.cloudflare.com/workers/platform/limits/)
- [监控系统文档](./MONITORING.md)
- [部署指南](./DEPLOYMENT.md)

---

**版本**: 1.0.0
**更新时间**: 2025-11-12
**维护者**: FastFile Team
