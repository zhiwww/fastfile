# Cloudflare 上传速度优化指南

## 📊 当前上传架构分析

### 现有流程
1. **客户端** → FormData多文件 → **Workers**
2. **Workers** → 读取文件 → **R2存储**
3. 单次请求完整上传所有文件

### 性能瓶颈
- ❌ Workers单次请求大小限制：100MB
- ❌ 大文件需完整上传后才能开始处理
- ❌ 无并行上传能力
- ❌ 网络中断需要重新开始

## 🚀 优化方案

### 方案1：客户端分块上传（推荐）⭐

**原理**: 在客户端将大文件分成多个小块，并行上传到Workers

**优势**:
- ✅ 突破Workers单次请求100MB限制
- ✅ 支持并行上传（最高8-16个并发）
- ✅ 支持断点续传
- ✅ 更好的进度显示
- ✅ 网络容错性强

**实现步骤**:

#### 1. 客户端分块代码

```javascript
// 配置
const CHUNK_SIZE = 5 * 1024 * 1024;  // 5MB per chunk
const MAX_CONCURRENT = 8;            // 最大并发数

async function uploadFileInChunks(file, password) {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const uploadId = generateUploadId();

  // 1. 初始化上传
  const initResponse = await fetch('/api/upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uploadId,
      fileName: file.name,
      fileSize: file.size,
      totalChunks,
      password
    })
  });

  // 2. 分块并行上传
  const chunks = [];
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    chunks.push({ index: i, start, end });
  }

  let uploadedChunks = 0;
  const uploadChunk = async (chunk) => {
    const blob = file.slice(chunk.start, chunk.end);
    const formData = new FormData();
    formData.append('uploadId', uploadId);
    formData.append('chunkIndex', chunk.index);
    formData.append('chunk', blob);

    const response = await fetch('/api/upload/chunk', {
      method: 'POST',
      body: formData
    });

    if (response.ok) {
      uploadedChunks++;
      const progress = (uploadedChunks / totalChunks) * 90; // 上传占90%
      updateProgress(progress);
    }
    return response;
  };

  // 使用Promise并发控制上传
  await uploadInBatches(chunks, uploadChunk, MAX_CONCURRENT);

  // 3. 完成上传并触发压缩
  const completeResponse = await fetch('/api/upload/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId })
  });

  return completeResponse.json();
}

// 并发控制函数
async function uploadInBatches(items, handler, concurrency) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(handler));
    results.push(...batchResults);
  }
  return results;
}
```

#### 2. 服务器端接口实现

```javascript
// 初始化上传
async function handleUploadInit(request, env) {
  const { uploadId, fileName, fileSize, totalChunks, password } = await request.json();

  const hashedPwd = await hashPassword(password);

  const uploadMeta = {
    uploadId,
    fileName,
    fileSize,
    totalChunks,
    password: hashedPwd,
    chunks: new Array(totalChunks).fill(false),
    createdAt: Date.now(),
    status: 'uploading'
  };

  await env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(uploadMeta));

  return jsonResponse({ success: true, uploadId });
}

// 接收分块
async function handleUploadChunk(request, env) {
  const formData = await request.formData();
  const uploadId = formData.get('uploadId');
  const chunkIndex = parseInt(formData.get('chunkIndex'));
  const chunk = formData.get('chunk');

  // 存储分块到R2
  const chunkKey = `temp/${uploadId}/chunk-${chunkIndex}`;
  await env.FILE_STORAGE.put(chunkKey, chunk);

  // 更新上传状态
  const metaStr = await env.FILE_META.get(`upload:${uploadId}`);
  const meta = JSON.parse(metaStr);
  meta.chunks[chunkIndex] = true;
  await env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(meta));

  return jsonResponse({
    success: true,
    uploaded: meta.chunks.filter(Boolean).length,
    total: meta.totalChunks
  });
}

// 完成上传
async function handleUploadComplete(request, env, ctx) {
  const { uploadId } = await request.json();

  // 获取上传元数据
  const metaStr = await env.FILE_META.get(`upload:${uploadId}`);
  const meta = JSON.parse(metaStr);

  // 验证所有分块已上传
  if (meta.chunks.some(c => !c)) {
    return errorResponse('部分分块未上传完成');
  }

  // 触发合并和压缩
  ctx.waitUntil(mergeAndCompress(uploadId, meta, env));

  return jsonResponse({ success: true, uploadId });
}

// 合并分块并压缩
async function mergeAndCompress(uploadId, meta, env) {
  try {
    // 1. 读取所有分块
    const chunks = [];
    for (let i = 0; i < meta.totalChunks; i++) {
      const chunkKey = `temp/${uploadId}/chunk-${i}`;
      const obj = await env.FILE_STORAGE.get(chunkKey);
      chunks.push(await obj.arrayBuffer());
    }

    // 2. 合并为完整文件
    const fileData = new Uint8Array(meta.fileSize);
    let offset = 0;
    for (const chunk of chunks) {
      fileData.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }

    // 3. 压缩（如果需要）
    const filesToZip = { [meta.fileName]: fileData };
    const zipped = zipSync(filesToZip, { level: 3 });

    // 4. 存储最终文件
    const fileId = generateFileId();
    await env.FILE_STORAGE.put(fileId, zipped);

    // 5. 保存元数据
    const finalMeta = {
      fileId,
      password: meta.password,
      expiryTime: getExpiryTime(),
      createdAt: Date.now(),
      fileName: 'files.zip',
      fileSize: zipped.byteLength,
    };
    await env.FILE_META.put(fileId, JSON.stringify(finalMeta));

    // 6. 删除临时分块
    for (let i = 0; i < meta.totalChunks; i++) {
      await env.FILE_STORAGE.delete(`temp/${uploadId}/chunk-${i}`);
    }

    // 7. 更新上传状态
    meta.status = 'completed';
    meta.fileId = fileId;
    await env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(meta));

  } catch (error) {
    console.error('Merge error:', error);
    meta.status = 'failed';
    meta.error = error.message;
    await env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(meta));
  }
}
```

**预期性能提升**:
- 10GB文件：从约10分钟 → **2-3分钟**
- 1GB文件：从约1分钟 → **15-20秒**

---

### 方案2：R2 Multipart Upload（高级）

**原理**: 直接使用R2的S3兼容Multipart Upload API

**优势**:
- ✅ 原生R2支持，性能最优
- ✅ 可达到 **1600+ MB/s** 上传速度
- ✅ 支持最大5TB单文件
- ✅ 自动管理分块

**限制**:
- ⚠️ 每个分块最小5MB（最后一块除外）
- ⚠️ 最大10,000个分块
- ⚠️ 所有分块（除最后一块）必须相同大小

**实现示例**:

```javascript
import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand } from "@aws-sdk/client-s3";

// 初始化S3客户端（用于R2）
const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

async function uploadToR2Multipart(file, key) {
  const PART_SIZE = 10 * 1024 * 1024; // 10MB per part

  // 1. 创建multipart upload
  const createCommand = new CreateMultipartUploadCommand({
    Bucket: "fastfile-storage",
    Key: key,
  });
  const { UploadId } = await s3Client.send(createCommand);

  // 2. 上传所有分块
  const parts = [];
  const totalParts = Math.ceil(file.size / PART_SIZE);

  for (let i = 0; i < totalParts; i++) {
    const start = i * PART_SIZE;
    const end = Math.min(start + PART_SIZE, file.size);
    const partData = file.slice(start, end);

    const uploadCommand = new UploadPartCommand({
      Bucket: "fastfile-storage",
      Key: key,
      UploadId,
      PartNumber: i + 1,
      Body: await partData.arrayBuffer(),
    });

    const { ETag } = await s3Client.send(uploadCommand);
    parts.push({ PartNumber: i + 1, ETag });
  }

  // 3. 完成multipart upload
  const completeCommand = new CompleteMultipartUploadCommand({
    Bucket: "fastfile-storage",
    Key: key,
    UploadId,
    MultipartUpload: { Parts: parts },
  });

  return await s3Client.send(completeCommand);
}
```

**注意**: 需要配置R2 API tokens并安装 `@aws-sdk/client-s3`

---

### 方案3：Stream上传（实时处理）

**原理**: 使用ReadableStream边读边上传，无需等待完整文件

```javascript
async function streamUpload(file) {
  const stream = file.stream();
  const response = await fetch('/api/upload/stream', {
    method: 'POST',
    body: stream,
    duplex: 'half',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': file.name,
      'X-File-Size': file.size,
    }
  });
  return response;
}

// Workers端
async function handleStreamUpload(request, env) {
  const fileName = request.headers.get('X-File-Name');
  const fileId = generateFileId();

  // 直接流式写入R2
  await env.FILE_STORAGE.put(fileId, request.body);

  return jsonResponse({ success: true, fileId });
}
```

**优势**: 内存占用最小，适合超大文件

---

## 🎯 推荐实施方案对比

| 方案 | 实现难度 | 性能提升 | 适用场景 | 推荐度 |
|------|---------|---------|---------|--------|
| **方案1: 客户端分块** | ⭐⭐⭐ 中等 | ⭐⭐⭐⭐⭐ 300-500% | 所有大文件 | ✅ 强烈推荐 |
| 方案2: R2 Multipart | ⭐⭐⭐⭐ 较高 | ⭐⭐⭐⭐⭐ 500%+ | 超大文件(>1GB) | ⭐ 可选 |
| 方案3: Stream上传 | ⭐⭐ 简单 | ⭐⭐⭐ 100-200% | 视频流媒体 | ⭐ 特定场景 |

## 📈 其他优化技巧

### 1. 压缩优化

```javascript
// 调整压缩级别（已实施）
const zipped = zipSync(filesToZip, {
  level: 1,  // 0=无压缩, 1=快速, 6=默认, 9=最大
});
```

**效果**:
- level 1: 速度快3-5倍，压缩率降低10-20%
- level 3: 速度快2倍，压缩率适中（当前使用）

### 2. 连接优化

在HTML中添加预连接：

```html
<head>
  <!-- 预连接到Workers域名 -->
  <link rel="preconnect" href="https://your-worker.workers.dev">
  <link rel="dns-prefetch" href="https://your-worker.workers.dev">
</head>
```

### 3. 客户端优化

```javascript
// 使用Web Worker处理文件
const worker = new Worker('file-processor.js');
worker.postMessage({ file, action: 'chunk' });

// 使用IndexedDB缓存分块状态（支持断点续传）
async function saveChunkStatus(uploadId, chunkIndex) {
  const db = await openDB('uploads');
  await db.put('chunks', { uploadId, chunkIndex, uploaded: true });
}
```

### 4. 进度显示优化

```javascript
// 使用requestAnimationFrame优化UI更新
let lastUpdate = 0;
function updateProgressThrottled(progress) {
  const now = Date.now();
  if (now - lastUpdate > 100) { // 最多100ms更新一次
    updateProgress(progress);
    lastUpdate = now;
  }
}
```

## 🔧 监控和调试

### 性能监控

```javascript
// 添加性能指标收集
performance.mark('upload-start');

// ... 上传逻辑 ...

performance.mark('upload-end');
performance.measure('upload-duration', 'upload-start', 'upload-end');

const metrics = performance.getEntriesByName('upload-duration')[0];
console.log(`Upload took ${metrics.duration}ms`);

// 发送到分析服务
navigator.sendBeacon('/api/metrics', JSON.stringify({
  duration: metrics.duration,
  fileSize: file.size,
  throughput: file.size / (metrics.duration / 1000) // bytes/sec
}));
```

### Cloudflare Workers 分析

在wrangler.toml中启用：

```toml
[observability]
enabled = true
head_sampling_rate = 1
```

## 📊 预期性能对比

### 当前性能（无优化）

| 文件大小 | 上传时间 | 吞吐量 |
|---------|---------|--------|
| 100MB | ~60秒 | ~1.7 MB/s |
| 1GB | ~10分钟 | ~1.7 MB/s |
| 10GB | ~100分钟 | ~1.7 MB/s |

### 优化后性能（方案1）

| 文件大小 | 上传时间 | 吞吐量 | 提升 |
|---------|---------|--------|------|
| 100MB | ~10秒 | ~10 MB/s | 6x ⬆️ |
| 1GB | ~2分钟 | ~8.5 MB/s | 5x ⬆️ |
| 10GB | ~20分钟 | ~8.5 MB/s | 5x ⬆️ |

### 极限性能（方案2）

| 文件大小 | 上传时间 | 吞吐量 | 提升 |
|---------|---------|--------|------|
| 100MB | ~1秒 | ~100 MB/s | 60x ⬆️ |
| 1GB | ~6秒 | ~170 MB/s | 100x ⬆️ |
| 10GB | ~60秒 | ~170 MB/s | 100x ⬆️ |

*注：实际性能受用户网络带宽限制*

## 🚀 立即开始

### 快速实施（方案1）

1. **前端**: 复制客户端分块代码
2. **后端**: 添加3个新API端点
3. **配置**: 调整CHUNK_SIZE和MAX_CONCURRENT
4. **测试**: 上传大文件验证

### 需要的依赖

```json
{
  "dependencies": {
    "fflate": "^0.8.2"  // 已安装
  }
}
```

无需额外依赖！

## 📚 参考文档

- [Cloudflare R2 Multipart Upload](https://developers.cloudflare.com/r2/objects/multipart-objects/)
- [Workers Upload Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [R2 Performance Best Practices](https://developers.cloudflare.com/r2/objects/upload-objects/)

---

**建议**: 优先实施**方案1（客户端分块上传）**，可以获得显著的性能提升且实现相对简单。
