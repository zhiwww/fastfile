# FastFile 技术文档

为 AI 助手和开发者准备的完整技术参考文档。

## 目录

- [项目概述](#项目概述)
- [技术架构](#技术架构)
- [核心代码](#核心代码)
- [关键功能实现](#关键功能实现)
- [数据流程](#数据流程)
- [已知问题](#已知问题)
- [开发注意事项](#开发注意事项)
- [扩展指南](#扩展指南)

## 项目概述

FastFile 是一个基于 Cloudflare Workers 的无服务器文件中转应用，支持大文件（最大10GB）的临时存储和分享。

### 核心特性

- **R2 Multipart Upload**：分块上传，突破 Workers 100MB 请求限制
- **智能重试机制**：指数退避算法，自动重试临时错误
- **完整监控系统**：结构化日志 + 性能指标 + 请求追踪
- **无服务器架构**：零运维，按需计费

### 技术选型

| 组件 | 技术 | 理由 |
|------|------|------|
| 计算平台 | Cloudflare Workers | 全球边缘计算，低延迟 |
| 对象存储 | Cloudflare R2 | S3 兼容，零出站费用 |
| 元数据存储 | Cloudflare KV | 低延迟键值存储 |
| R2 API | aws4fetch | 轻量级 AWS 签名库 |
| 压缩库 | fflate | 高性能，Workers 兼容 |
| 日志系统 | 自研 logger.js | 结构化日志，易于查询 |

## 技术架构

### 系统架构图

```
┌─────────────┐
│   Browser   │ 用户浏览器
└──────┬──────┘
       │ HTTPS
       ↓
┌─────────────┐
│   Worker    │ Cloudflare Workers (边缘计算)
│  (计算层)    │ - 路由处理
└──────┬──────┘ - 认证验证
       │         - 文件处理
       │         - 监控日志
       ↓
┌─────────────┐
│     KV      │ Cloudflare KV (元数据)
│  (元数据)    │ - 文件元信息
└─────────────┘ - 上传状态
                 - 密码哈希
       ↓
┌─────────────┐
│     R2      │ Cloudflare R2 (对象存储)
│  (对象存储)   │ - 文件数据
└─────────────┘ - 临时分块
                 - 压缩包
```

### 上传流程

```
客户端                Worker                 R2 Storage
  │                    │                        │
  │──① Init Upload───→│                        │
  │                    │──Create Multipart────→│
  │←─UploadId + URL───│                        │
  │                    │                        │
  │──② Upload Chunk 1─→│                        │
  │                    │──Sign & Forward──────→│
  │←─ETag──────────────│←─ETag─────────────────│
  │                    │                        │
  │──③ Upload Chunk 2─→│ (并发最多4个)          │
  │                    │──Sign & Forward──────→│
  │                    │                        │
  │──④ Complete────────→│                        │
  │                    │──Complete Multipart──→│
  │                    │──Merge & Compress────→│
  │←─FileId────────────│                        │
```

### 文件结构

```
src/
├── index-r2.js          # 主入口文件（约1000行）
│   ├── CONFIG           # 配置常量
│   ├── fetch()          # 请求路由
│   ├── handleUploadInit()      # 初始化上传
│   ├── handleUploadChunk()     # 上传分块
│   ├── handleUploadComplete()  # 完成上传
│   ├── handleVerify()          # 验证密码
│   ├── handleDownload()        # 下载文件
│   ├── scheduled()             # 定时清理
│   └── HTML Templates          # 内嵌HTML页面
│
├── logger.js            # 日志系统（约300行）
│   ├── Logger           # 结构化日志类
│   ├── MetricsTracker   # 指标收集器
│   ├── RequestTracker   # 请求追踪器
│   └── UploadSessionTracker  # 上传追踪器
│
└── utils.js             # 工具函数（约100行）
    ├── generateFileId() # 生成文件ID
    ├── hashPassword()   # 密码哈希
    ├── verifyPassword() # 密码验证
    ├── jsonResponse()   # JSON响应
    └── errorResponse()  # 错误响应
```

## 核心代码

### 1. src/index-r2.js - 主入口

**关键常量**

```javascript
const CONFIG = {
  CHUNK_SIZE: 10 * 1024 * 1024,    // 10MB/chunk
  MAX_CONCURRENT: 4,                // 最大并发数
  MAX_RETRY_ATTEMPTS: 5,            // 最大重试次数
  RETRY_DELAY_BASE: 1000,           // 重试延迟基数(ms)
};

const R2_LIMITS = {
  MIN_PART_SIZE: 5 * 1024 * 1024,  // R2 最小part大小
  MAX_PART_SIZE: 5 * 1024 * 1024 * 1024,  // 5GB
  MAX_PARTS: 10000,                 // 最大part数
};
```

**重试机制**

```javascript
// 判断错误是否可重试
function isRetryableError(error, statusCode) {
  // 可重试的HTTP状态码
  const retryableStatusCodes = [408, 429, 500, 502, 503, 504];

  // 网络错误模式（14种）
  const retryableErrorPatterns = [
    'network', 'timeout', 'econnreset', 'etimedout',
    'connection lost', 'connection closed', 'socket hang up',
    'enotfound', 'econnrefused', 'fetch failed',
    'failed to fetch', 'network request failed',
    'aborted', 'request aborted'
  ];

  // 判断逻辑...
}

// 指数退避重试
async function retryWithBackoff(fn, maxAttempts, operation) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryableError(error) || attempt === maxAttempts) {
        throw error;
      }

      // 计算延迟: base * 2^(attempt-1) + jitter
      const baseDelay = RETRY_DELAY_BASE * Math.pow(2, attempt - 1);
      const jitter = Math.random() * 1000;
      const delay = baseDelay + jitter;

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
```

**路由处理**

```javascript
export default {
  async fetch(request, env, ctx) {
    const requestId = generateRequestId();
    const logger = createLogger(env);
    const metrics = new MetricsTracker();
    const tracker = new RequestTracker(requestId, logger, metrics);

    const url = new URL(request.url);
    const path = url.pathname;

    // API路由
    if (path === '/api/upload/init') {
      return await handleUploadInit(request, env, logger, metrics);
    }

    if (path === '/api/upload/chunk') {
      return await handleUploadChunk(request, env, logger, metrics);
    }

    if (path === '/api/upload/complete') {
      return await handleUploadComplete(request, env, ctx, logger, metrics);
    }

    // 页面路由
    if (path === '/' || path === '/upload') {
      return new Response(UPLOAD_PAGE_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (path.startsWith('/d/')) {
      const fileId = path.split('/')[2];
      return new Response(DOWNLOAD_PAGE_HTML(fileId), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
};
```

**上传初始化**

```javascript
async function handleUploadInit(request, env, logger, metrics) {
  const body = await request.json();
  const { files, password, totalSize } = body;

  // 验证密码格式
  if (!isValidPassword(password)) {
    return errorResponse('密码必须是4位数字', 400);
  }

  // 生成uploadId
  const uploadId = generateFileId();

  // 为每个文件创建 R2 Multipart Upload
  const fileUploads = [];
  for (const file of files) {
    const uploadData = await createMultipartUpload(file.name, env);
    fileUploads.push({
      fileName: file.name,
      fileSize: file.size,
      uploadId: uploadData.UploadId,
      parts: []
    });
  }

  // 保存元数据到KV
  const meta = {
    uploadId,
    password: await hashPassword(password),
    files: fileUploads,
    totalSize,
    status: 'uploading',
    createdAt: Date.now()
  };

  await env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(meta));

  metrics.increment('upload.init', 1);
  logger.info('Upload initialized', { uploadId, fileCount: files.length });

  return jsonResponse({ success: true, uploadId });
}
```

**上传分块**

```javascript
async function handleUploadChunk(request, env, logger, metrics) {
  const formData = await request.formData();
  const uploadId = formData.get('uploadId');
  const fileIndex = parseInt(formData.get('fileIndex'));
  const partNumber = parseInt(formData.get('partNumber'));
  const chunk = formData.get('chunk');

  // 获取上传元数据
  const metaStr = await env.FILE_META.get(`upload:${uploadId}`);
  const meta = JSON.parse(metaStr);
  const fileUpload = meta.files[fileIndex];

  // 使用重试机制上传到R2
  const result = await retryWithBackoff(
    async () => {
      return await uploadPartToR2(
        fileUpload.fileName,
        fileUpload.uploadId,
        partNumber,
        chunk,
        env
      );
    },
    CONFIG.MAX_RETRY_ATTEMPTS,
    `Upload part ${partNumber} for file ${fileUpload.fileName}`
  );

  // 保存ETag
  fileUpload.parts.push({
    PartNumber: partNumber,
    ETag: result.ETag
  });

  await env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(meta));

  metrics.increment('chunk.success', 1);
  metrics.gauge('chunk.size', chunk.size);

  return jsonResponse({ success: true, ETag: result.ETag });
}
```

**完成上传**

```javascript
async function handleUploadComplete(request, env, ctx, logger, metrics) {
  const { uploadId } = await request.json();

  // 获取元数据
  const metaStr = await env.FILE_META.get(`upload:${uploadId}`);
  const meta = JSON.parse(metaStr);

  // 后台处理：合并 + 压缩 + 清理
  ctx.waitUntil((async () => {
    try {
      // 1. 完成所有文件的multipart upload
      for (const fileUpload of meta.files) {
        await completeMultipartUpload(
          fileUpload.fileName,
          fileUpload.uploadId,
          fileUpload.parts,
          env
        );
      }

      // 2. 下载所有文件
      const filesToZip = {};
      for (const fileUpload of meta.files) {
        const obj = await env.FILE_STORAGE.get(fileUpload.fileName);
        const data = await obj.arrayBuffer();
        filesToZip[fileUpload.fileName] = new Uint8Array(data);
      }

      // 3. 压缩
      const zipped = zipSync(filesToZip, { level: 3 });

      // 4. 保存最终文件
      const fileId = generateFileId();
      await env.FILE_STORAGE.put(fileId, zipped);

      // 5. 保存元数据
      const finalMeta = {
        fileId,
        password: meta.password,
        expiryTime: getExpiryTime(),
        createdAt: Date.now(),
        fileName: 'files.zip',
        fileSize: zipped.byteLength
      };

      await env.FILE_META.put(fileId, JSON.stringify(finalMeta));

      // 6. 清理临时文件
      for (const fileUpload of meta.files) {
        await env.FILE_STORAGE.delete(fileUpload.fileName);
      }

      // 7. 更新上传状态
      meta.status = 'completed';
      meta.fileId = fileId;
      await env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(meta));

      logger.info('Upload completed', { uploadId, fileId });
      metrics.increment('upload.complete', 1, { success: true });
    } catch (error) {
      logger.error('Upload completion failed', { uploadId, error });
      metrics.increment('upload.complete', 1, { success: false });
    }
  })());

  return jsonResponse({ success: true, uploadId });
}
```

### 2. src/logger.js - 日志系统

**Logger 类**

```javascript
class Logger {
  constructor(context = {}, minLevel = LogLevel.INFO) {
    this.context = context;
    this.minLevel = minLevel;
  }

  // 创建子日志器
  child(additionalContext) {
    return new Logger(
      { ...this.context, ...additionalContext },
      this.minLevel
    );
  }

  // 格式化日志
  formatLog(level, message, data = {}) {
    return {
      timestamp: new Date().toISOString(),
      level: LogLevelNames[level],
      message,
      ...this.context,
      ...data
    };
  }

  // 输出日志
  info(message, data = {}) {
    this.log(LogLevel.INFO, message, data);
  }

  error(message, data = {}) {
    this.log(LogLevel.ERROR, message, data);
  }
}
```

**MetricsTracker 类**

```javascript
class MetricsTracker {
  constructor() {
    this.metrics = [];
  }

  // Counter - 计数器
  increment(name, value = 1, tags = {}) {
    this.metrics.push({
      name,
      tags,
      value,
      type: 'counter',
      timestamp: Date.now()
    });
  }

  // Timing - 计时器
  timing(name, value, tags = {}) {
    this.metrics.push({
      name,
      tags,
      value,
      type: 'timing',
      unit: 'ms',
      timestamp: Date.now()
    });
  }

  // Gauge - 测量值
  gauge(name, value, tags = {}) {
    this.metrics.push({
      name,
      tags,
      value,
      type: 'gauge',
      timestamp: Date.now()
    });
  }

  // 输出所有指标
  async flush(logger) {
    if (this.metrics.length > 0) {
      logger.info('Metrics report', { metrics: this.metrics });
      this.metrics = [];
    }
  }
}
```

**RequestTracker 类**

```javascript
class RequestTracker {
  constructor(requestId, logger, metrics) {
    this.requestId = requestId;
    this.logger = logger.child({ requestId });
    this.metrics = metrics;
    this.startTime = Date.now();
    this.events = [];
  }

  // 记录事件
  event(name, data = {}) {
    this.events.push({ name, data, time: Date.now() });
    this.logger.debug(`Event: ${name}`, data);
  }

  // 记录错误
  error(error) {
    this.logger.error('Request error', { error });
    this.metrics.increment('request.errors', 1, {
      error_type: error.name
    });
  }

  // 完成请求
  finish(statusCode, additionalData = {}) {
    const duration = Date.now() - this.startTime;

    this.logger.info('Request completed', {
      statusCode,
      duration,
      events: this.events.length,
      ...additionalData
    });

    this.metrics.timing('request.duration', duration, {
      status: statusCode
    });

    this.metrics.increment('request.total', 1, {
      status: statusCode
    });
  }
}
```

### 3. src/utils.js - 工具函数

```javascript
// 生成8位随机文件ID
export function generateFileId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// 验证密码格式（4位数字）
export function isValidPassword(password) {
  return /^\d{4}$/.test(password);
}

// 密码哈希
export async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// 验证密码
export async function verifyPassword(password, hashedPassword) {
  const hash = await hashPassword(password);
  return hash === hashedPassword;
}

// JSON响应
export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
```

## 关键功能实现

### R2 Multipart Upload

**为什么使用 aws4fetch？**

- AWS SDK 在 Workers 环境中不兼容（依赖 DOMParser）
- aws4fetch 专为 Fetch API 设计，轻量且兼容

**实现步骤**

1. **创建 Multipart Upload**

```javascript
async function createMultipartUpload(fileName, env) {
  const client = getAwsClient(env);
  const url = `${getR2Url(env)}/${fileName}?uploads`;

  const signedRequest = await client.sign(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' }
  });

  const response = await fetch(signedRequest);
  const result = await parseXmlResponse(response);

  return result; // { UploadId: '...' }
}
```

2. **上传 Part**

```javascript
async function uploadPartToR2(fileName, uploadId, partNumber, data, env) {
  const client = getAwsClient(env);
  const url = `${getR2Url(env)}/${fileName}?partNumber=${partNumber}&uploadId=${uploadId}`;

  const signedRequest = await client.sign(url, {
    method: 'PUT',
    body: data
  });

  const response = await fetch(signedRequest);
  const etag = response.headers.get('ETag');

  return { ETag: etag };
}
```

3. **完成 Multipart Upload**

```javascript
async function completeMultipartUpload(fileName, uploadId, parts, env) {
  const client = getAwsClient(env);
  const url = `${getR2Url(env)}/${fileName}?uploadId=${uploadId}`;

  // 构造XML
  const partsXml = parts
    .map(p => `<Part><PartNumber>${p.PartNumber}</PartNumber><ETag>${p.ETag}</ETag></Part>`)
    .join('');
  const xml = `<CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`;

  const signedRequest = await client.sign(url, {
    method: 'POST',
    body: xml,
    headers: { 'Content-Type': 'application/xml' }
  });

  const response = await fetch(signedRequest);
  return response.ok;
}
```

### 前端分块上传

**客户端代码（内嵌在 HTML 中）**

```javascript
async function uploadFiles(files, password) {
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  // 1. 初始化上传
  const initResponse = await fetch('/api/upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: files.map(f => ({ name: f.name, size: f.size })),
      password,
      totalSize
    })
  });

  const { uploadId } = await initResponse.json();

  // 2. 并发上传所有文件的chunks
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex];
    const chunks = [];

    for (let i = 0; i * CHUNK_SIZE < file.size; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      chunks.push({ index: i, start, end });
    }

    // 并发上传chunks（最多4个）
    await uploadChunksInBatches(chunks, file, uploadId, fileIndex, MAX_CONCURRENT);
  }

  // 3. 完成上传
  const completeResponse = await fetch('/api/upload/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId })
  });

  return await completeResponse.json();
}
```

### 定时清理

```javascript
export default {
  async scheduled(event, env, ctx) {
    const logger = createLogger(env);
    logger.info('Cleanup task started');

    try {
      // 获取所有文件
      const keys = await env.FILE_META.list();

      for (const key of keys.keys) {
        const metaStr = await env.FILE_META.get(key.name);
        const meta = JSON.parse(metaStr);

        // 检查是否过期
        if (isExpired(meta.expiryTime)) {
          // 删除文件
          await env.FILE_STORAGE.delete(meta.fileId);
          // 删除元数据
          await env.FILE_META.delete(key.name);

          logger.info('File cleaned up', { fileId: meta.fileId });
        }
      }

      logger.info('Cleanup task completed');
    } catch (error) {
      logger.error('Cleanup task failed', { error });
    }
  }
};
```

## 数据流程

### 元数据存储（KV）

**上传元数据**（临时）

```json
{
  "key": "upload:abc123",
  "value": {
    "uploadId": "abc123",
    "password": "hash...",
    "files": [
      {
        "fileName": "test.bin",
        "fileSize": 104857600,
        "uploadId": "r2-upload-id",
        "parts": [
          { "PartNumber": 1, "ETag": "etag1" },
          { "PartNumber": 2, "ETag": "etag2" }
        ]
      }
    ],
    "totalSize": 104857600,
    "status": "uploading",
    "createdAt": 1699999999999
  }
}
```

**文件元数据**（永久，直到过期）

```json
{
  "key": "xyz789",
  "value": {
    "fileId": "xyz789",
    "password": "hash...",
    "expiryTime": 1702591999999,
    "createdAt": 1699999999999,
    "fileName": "files.zip",
    "fileSize": 98765432
  }
}
```

### 对象存储（R2）

**临时文件**（上传过程中）

```
temp/abc123/part-1
temp/abc123/part-2
...
```

**最终文件**

```
xyz789  # 压缩后的zip文件
```

## 已知问题

### 1. 内存限制

**问题**：Workers 内存限制 128MB，处理大文件时可能超限。

**当前缓解措施**：
- 使用流式处理
- 不在内存中完整加载文件
- 分块处理

**未来优化**：
- 实现真正的流式压缩（fflate AsyncZipDeflate）
- 使用 Durable Objects 处理超大文件

### 2. CPU 时间限制

**问题**：压缩 10GB 文件需要约 2.3 分钟，超过默认 30 秒限制。

**当前解决方案**：
- 在 wrangler.toml 中设置 `limits = { cpu_ms = 150000 }`
- 使用压缩级别 3（快速压缩）

**注意**：最大 CPU 时间为 300 秒（5分钟）。

### 3. 断点续传

**问题**：前端刷新页面后无法继续上传。

**当前状态**：未实现

**实现建议**：
- 使用 IndexedDB 缓存上传状态
- 记录已上传的 chunks
- 支持从中断点继续

### 4. 并发限制

**问题**：高并发时可能触发 R2 速率限制。

**当前解决方案**：
- 限制并发数为 4
- 实现重试机制
- 指数退避避免请求风暴

## 开发注意事项

### 1. Workers 环境限制

**不可用的 Node.js API**：
- `fs`（文件系统）
- `path`（路径操作）
- `child_process`（子进程）
- 完整的 `stream`（流）

**可用的 Web API**：
- Fetch API
- Crypto API
- TextEncoder/TextDecoder
- ArrayBuffer/Uint8Array

### 2. 异步操作

**使用 ctx.waitUntil()**：

```javascript
// ❌ 错误：不等待异步操作
const response = jsonResponse({ success: true });
performHeavyTask();  // 可能在响应返回后被中断
return response;

// ✅ 正确：使用 waitUntil
const response = jsonResponse({ success: true });
ctx.waitUntil(performHeavyTask());
return response;
```

### 3. KV 操作

**限制**：
- 键名最大 512 字节
- 值最大 25MB
- 写入速率：1000 次/秒

**最佳实践**：
- 使用前缀组织键（如 `upload:`, `file:`）
- 大数据存 R2，元数据存 KV
- 避免频繁写入同一个键

### 4. R2 操作

**限制**：
- Multipart 每个 part 最小 5MB（最后一个除外）
- 最多 10000 个 parts
- 单个对象最大 5TB

**最佳实践**：
- 使用 Multipart Upload 处理大文件
- 合理设置 part 大小（建议 10-50MB）
- 完成后立即删除临时 parts

### 5. 日志和监控

**始终添加日志**：

```javascript
// 每个关键操作都应记录日志
logger.info('Operation started', { operationId });

try {
  await performOperation();
  logger.info('Operation completed', { operationId });
} catch (error) {
  logger.error('Operation failed', { operationId, error });
  throw error;
}
```

**收集指标**：

```javascript
const startTime = Date.now();
await performOperation();
const duration = Date.now() - startTime;

metrics.timing('operation.duration', duration);
metrics.increment('operation.success', 1);
```

### 6. 错误处理

**始终处理错误**：

```javascript
// ❌ 错误：未捕获异常
const data = await fetchData();

// ✅ 正确：完整的错误处理
try {
  const data = await fetchData();
  return successResponse(data);
} catch (error) {
  logger.error('Fetch failed', { error });
  metrics.increment('fetch.errors', 1);
  return errorResponse('Failed to fetch data', 500);
}
```

## 扩展指南

### 添加新功能

**1. 添加新的 API 端点**

```javascript
// src/index-r2.js
if (path === '/api/new-feature' && request.method === 'POST') {
  const response = await handleNewFeature(request, env, logger, metrics);
  tracker.finish(response.status, { handler: 'new-feature' });
  ctx.waitUntil(metrics.flush(logger));
  return response;
}

async function handleNewFeature(request, env, logger, metrics) {
  const featureLogger = logger.child({ handler: 'new-feature' });

  try {
    // 你的逻辑
    featureLogger.info('Feature executed');
    metrics.increment('new_feature.success', 1);

    return jsonResponse({ success: true });
  } catch (error) {
    featureLogger.error('Feature failed', { error });
    metrics.increment('new_feature.errors', 1);
    return errorResponse('Feature failed', 500);
  }
}
```

**2. 添加新的配置参数**

```javascript
// src/index-r2.js
const CONFIG = {
  CHUNK_SIZE: 10 * 1024 * 1024,
  MAX_CONCURRENT: 4,
  NEW_PARAMETER: 123,  // 新参数
};
```

**3. 添加新的环境变量**

```toml
# wrangler.toml
[vars]
NEW_VAR = "value"
```

```bash
# 或使用 secrets
wrangler secret put NEW_SECRET
```

### 性能优化

**1. 调整分块大小**

```javascript
// 更大的chunk = 更快但更容易失败
const CONFIG = {
  CHUNK_SIZE: 20 * 1024 * 1024,  // 20MB
};
```

**2. 调整并发数**

```javascript
// 更高的并发 = 更快但更容易触发限制
const CONFIG = {
  MAX_CONCURRENT: 8,
};
```

**3. 调整压缩级别**

```javascript
// 更低的级别 = 更快但压缩率低
const zipped = zipSync(filesToZip, { level: 1 });
```

### 监控增强

**1. 添加自定义指标**

```javascript
metrics.increment('custom.metric', 1, {
  tag1: 'value1',
  tag2: 'value2'
});

metrics.timing('custom.duration', durationMs);

metrics.gauge('custom.size', sizeBytes);
```

**2. 添加告警规则**

在 Cloudflare Dashboard 或 Grafana 中配置告警。

### 测试

**本地测试**

```bash
# 运行本地开发服务器
npm run dev

# 测试上传
curl -X POST http://localhost:8787/api/upload/init \
  -H "Content-Type: application/json" \
  -d '{"files":[{"name":"test.txt","size":100}],"password":"1234"}'
```

**生产测试**

```bash
# 部署到生产环境
npm run deploy

# 查看实时日志
wrangler tail

# 监控错误
wrangler tail --format json | jq 'select(.level == "ERROR")'
```

## 相关文档

- [部署指南](./docs/DEPLOYMENT.md)
- [R2 配置](./docs/R2_SETUP.md)
- [监控系统](./docs/MONITORING.md)
- [性能优化](./docs/OPTIMIZATION.md)

## 更新日志

- **2025-11-12**: 创建技术文档
- **2025-11-11**: 实现 R2 Multipart Upload
- **2025-11-11**: 增强重试机制（5次重试，14种错误模式）
- **2025-11-11**: 集成完整监控系统

---

**文档版本**: 1.0.0
**维护者**: FastFile Team
**最后更新**: 2025-11-12
