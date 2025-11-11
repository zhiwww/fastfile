/**
 * FastFile - Cloudflare Workers 主入口
 * R2 Multipart Upload 优化版本 (使用aws4fetch)
 * 带监控和日志支持
 */

import { AwsClient } from 'aws4fetch';
import { Zip, ZipPassThrough, strToU8 } from 'fflate';
import {
  generateFileId,
  isValidPassword,
  getExpiryTime,
  isExpired,
  hashPassword,
  verifyPassword,
  jsonResponse,
  errorResponse
} from './utils.js';
import {
  createLogger,
  generateRequestId,
  MetricsTracker,
  RequestTracker,
  UploadSessionTracker
} from './logger.js';

// 用于存储压缩进度的临时状态
const compressionProgress = new Map();

// =============================================
// 统一配置 - 前后端共享
// =============================================
const CONFIG = {
  CHUNK_SIZE: 5 * 1024 * 1024, // 10MB - R2 multipart 要求每个 part 至少 5MB（除最后一个）
  MAX_CONCURRENT: 6, // 最大并发上传数
  MAX_RETRY_ATTEMPTS: 5, // 最大重试次数
  RETRY_DELAY_BASE: 1000, // 基础重试延迟(ms)
};


// R2 multipart upload 限制
const R2_LIMITS = {
  MIN_PART_SIZE: 5 * 1024 * 1024, // 5MB - R2 要求的最小 part 大小（除最后一个）
  MAX_PART_SIZE: 5 * 1024 * 1024 * 1024, // 5GB - 单个 part 的最大大小
  MAX_PARTS: 10000, // 最大 part 数量
};

/**
 * 判断错误是否可重试
 */
function isRetryableError(error, statusCode) {
  // 可重试的HTTP状态码
  const retryableStatusCodes = [
    408, // Request Timeout
    429, // Too Many Requests
    500, // Internal Server Error
    502, // Bad Gateway
    503, // Service Unavailable
    504, // Gateway Timeout
  ];

  if (statusCode && retryableStatusCodes.includes(statusCode)) {
    return true;
  }

  // 网络错误（扩展）
  const errorMessage = (error.message || String(error)).toLowerCase();
  const retryableErrorPatterns = [
    'network',
    'timeout',
    'econnreset',
    'etimedout',
    'connection lost',
    'connection closed',
    'socket hang up',
    'enotfound',
    'econnrefused',
    'fetch failed',
    'failed to fetch',
    'network request failed',
    'aborted',
    'request aborted',
  ];

  for (const pattern of retryableErrorPatterns) {
    if (errorMessage.includes(pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * 指数退避重试函数
 */
async function retryWithBackoff(fn, maxAttempts = CONFIG.MAX_RETRY_ATTEMPTS, operation = 'operation') {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // 解析HTTP状态码
      const statusCode = error.statusCode || (error.response && error.response.status);

      // 判断是否可重试
      if (!isRetryableError(error, statusCode)) {
        console.error(`${operation} failed with non-retryable error:`, error.message);
        throw error;
      }

      // 如果是最后一次尝试，直接抛出错误
      if (attempt === maxAttempts) {
        console.error(`${operation} failed after ${maxAttempts} attempts:`, error.message);
        throw error;
      }

      // 计算退避延迟: base * 2^(attempt-1) + random jitter
      const baseDelay = CONFIG.RETRY_DELAY_BASE * Math.pow(2, attempt - 1);
      const jitter = Math.random() * 1000; // 0-1秒的随机抖动
      const delay = baseDelay + jitter;

      console.warn(`⚠️ ${operation} attempt ${attempt} failed (${error.message}), retrying in ${Math.round(delay)}ms...`);

      // 等待后重试
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * 获取aws4fetch客户端
 */
function getAwsClient(env) {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  });
}

/**
 * 获取R2 bucket URL
 */
function getR2Url(env) {
  const accountId = env.R2_ACCOUNT_ID;
  const bucketName = env.R2_BUCKET_NAME || 'fastfile-storage';
  return `https://${accountId}.r2.cloudflarestorage.com/${bucketName}`;
}

/**
 * 解析XML响应
 */
async function parseXmlResponse(response) {
  const text = await response.text();
  const result = {};

  // 简单的XML解析（只提取我们需要的字段）
  const uploadIdMatch = text.match(/<UploadId>(.*?)<\/UploadId>/);
  if (uploadIdMatch) {
    result.UploadId = uploadIdMatch[1];
  }

  const eTagMatch = text.match(/<ETag>(.*?)<\/ETag>/);
  if (eTagMatch) {
    result.ETag = eTagMatch[1].replace(/&quot;/g, '"');
  }

  return result;
}

export default {
  async fetch(request, env, ctx) {
    // 初始化监控
    const requestId = generateRequestId();
    const logger = createLogger(env);
    const metrics = new MetricsTracker();
    const tracker = new RequestTracker(requestId, logger, metrics);

    const url = new URL(request.url);
    const path = url.pathname;

    tracker.event('request.start', {
      method: request.method,
      path,
      userAgent: request.headers.get('user-agent')
    });

    // CORS预检请求
    if (request.method === 'OPTIONS') {
      const response = new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
      tracker.finish(200, { type: 'CORS preflight' });
      ctx.waitUntil(metrics.flush(logger));
      return response;
    }

    // 路由处理
    try {
      // API路由
      if (path.startsWith('/api/')) {
        // R2 Multipart Upload 路由
        if (path === '/api/upload/init' && request.method === 'POST') {
          const response = await handleUploadInit(request, env, logger, metrics);
          tracker.finish(response.status, { handler: 'upload.init' });
          ctx.waitUntil(metrics.flush(logger));
          return response;
        }

        if (path === '/api/upload/chunk' && request.method === 'POST') {
          const response = await handleUploadChunk(request, env, logger, metrics);
          tracker.finish(response.status, { handler: 'upload.chunk' });
          ctx.waitUntil(metrics.flush(logger));
          return response;
        }

        if (path === '/api/upload/complete' && request.method === 'POST') {
          const response = await handleUploadComplete(request, env, ctx, logger, metrics);
          tracker.finish(response.status, { handler: 'upload.complete' });
          ctx.waitUntil(metrics.flush(logger));
          return response;
        }

        if (path === '/api/verify' && request.method === 'POST') {
          const response = await handleVerify(request, env);
          tracker.finish(response.status, { handler: 'verify' });
          ctx.waitUntil(metrics.flush(logger));
          return response;
        }

        if (path.startsWith('/api/download/')) {
          const fileId = path.split('/')[3];
          const response = await handleDownload(fileId, request, env);
          tracker.finish(response.status, { handler: 'download', fileId });
          ctx.waitUntil(metrics.flush(logger));
          return response;
        }

        if (path.startsWith('/api/upload-status/')) {
          const uploadId = path.split('/')[3];
          const response = await handleUploadStatus(uploadId, env);
          tracker.finish(response.status, { handler: 'upload-status', uploadId });
          ctx.waitUntil(metrics.flush(logger));
          return response;
        }

        const response = errorResponse('API端点不存在', 404);
        tracker.finish(404, { handler: 'not_found' });
        ctx.waitUntil(metrics.flush(logger));
        return response;
      }

      // 下载页面路由
      if (path.startsWith('/d/')) {
        const fileId = path.split('/')[2];
        const response = await serveDownloadPage(fileId, env);
        tracker.finish(response.status, { handler: 'download-page', fileId });
        ctx.waitUntil(metrics.flush(logger));
        return response;
      }

      // 默认返回上传页面
      if (path === '/' || path === '/index.html') {
        const response = await serveUploadPage();
        tracker.finish(response.status, { handler: 'upload-page' });
        ctx.waitUntil(metrics.flush(logger));
        return response;
      }

      const response = errorResponse('页面不存在', 404);
      tracker.finish(404, { handler: 'not_found' });
      ctx.waitUntil(metrics.flush(logger));
      return response;
    } catch (error) {
      tracker.error(error, { path });
      tracker.finish(500, { error: error.message });
      logger.fatal('Request failed', { error, requestId, url: request.url });
      ctx.waitUntil(metrics.flush(logger));
      return errorResponse('服务器错误: ' + error.message, 500);
    }
  },

  // 定时任务：清理过期文件
  async scheduled(event, env, ctx) {
    await cleanupExpiredFiles(env);
  },
};

/**
 * 初始化分块上传 (Phase 1)
 */
async function handleUploadInit(request, env, logger, metrics) {
  const requestLogger = logger ? logger.child({ handler: 'upload.init' }) : { info: () => { }, warn: () => { }, error: () => { } };

  try {
    const { files, password } = await request.json();

    requestLogger.info('Upload init request', {
      filesCount: files.length,
      totalSize: files.reduce((sum, f) => sum + f.size, 0)
    });

    // 验证密码
    if (!password || !isValidPassword(password)) {
      requestLogger.warn('Invalid password provided');
      if (metrics) metrics.increment('upload.init.invalid_password', 1);
      return errorResponse('密码必须是4位数字');
    }

    // 验证文件
    if (!files || files.length === 0) {
      return errorResponse('请选择要上传的文件');
    }

    // 生成上传ID
    const uploadId = generateFileId();
    const hashedPwd = await hashPassword(password);

    // 检查是否为单个zip文件（跳过压缩）
    const isSingleZip = files.length === 1 && files[0].name.toLowerCase().endsWith('.zip');

    // 初始化aws4fetch客户端
    const awsClient = getAwsClient(env);
    const r2Url = getR2Url(env);

    // 为每个文件创建multipart upload
    const fileUploads = [];
    for (const file of files) {
      const tempKey = `temp/${uploadId}/${file.name}`;

      // 使用重试机制创建multipart upload
      const xmlResult = await retryWithBackoff(
        async () => {
          const createResponse = await awsClient.fetch(`${r2Url}/${tempKey}?uploads`, {
            method: 'POST',
          });

          if (!createResponse.ok) {
            const errorText = await createResponse.text();
            const error = new Error(`创建multipart upload失败: ${errorText}`);
            error.statusCode = createResponse.status;
            throw error;
          }

          return await parseXmlResponse(createResponse);
        },
        CONFIG.MAX_RETRY_ATTEMPTS,
        `Create multipart upload for ${file.name}`
      );

      const totalChunks = Math.ceil(file.size / CONFIG.CHUNK_SIZE);

      fileUploads.push({
        name: file.name,
        size: file.size,
        key: tempKey,
        uploadId: xmlResult.UploadId,
        totalChunks
        // 注意：不再使用 uploadedChunks 数组，改为独立的 KV 记录
      });
    }

    // 保存上传元数据
    const uploadMeta = {
      uploadId,
      password: hashedPwd,
      files: fileUploads,
      isSingleZip,
      totalSize: files.reduce((sum, f) => sum + f.size, 0),
      uploadedAt: Date.now(),
      status: 'uploading' // uploading, uploaded, compressing, completed, failed
    };

    await env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(uploadMeta));

    return jsonResponse({
      success: true,
      uploadId,
      files: fileUploads.map(f => ({
        name: f.name,
        totalChunks: f.totalChunks,
        uploadId: f.uploadId
      })),
      isSingleZip,
      chunkSize: CONFIG.CHUNK_SIZE
    });

  } catch (error) {
    console.error('Init error:', error);
    return errorResponse('初始化失败: ' + error.message, 500);
  }
}

/**
 * 上传单个分块
 */
async function handleUploadChunk(request, env, logger, metrics) {
  const requestLogger = logger ? logger.child({ handler: 'upload.chunk' }) : { info: () => { }, debug: () => { }, error: () => { } };
  const startTime = Date.now();

  try {
    const formData = await request.formData();
    const uploadId = formData.get('uploadId');
    const fileName = formData.get('fileName');
    const chunkIndex = parseInt(formData.get('chunkIndex'));
    const chunk = formData.get('chunk');

    // 获取上传元数据
    const metaStr = await env.FILE_META.get(`upload:${uploadId}`);
    if (!metaStr) {
      return errorResponse('上传不存在', 404);
    }

    const meta = JSON.parse(metaStr);
    const fileUpload = meta.files.find(f => f.name === fileName);

    if (!fileUpload) {
      return errorResponse('文件不存在', 404);
    }

    // 初始化aws4fetch客户端
    const awsClient = getAwsClient(env);
    const r2Url = getR2Url(env);

    // 使用aws4fetch上传分块
    const partNumber = chunkIndex + 1; // Part number从1开始
    const chunkBody = await chunk.arrayBuffer();

    // 使用重试机制上传分块
    const { response, etag } = await retryWithBackoff(
      async () => {
        const uploadResponse = await awsClient.fetch(
          `${r2Url}/${fileUpload.key}?partNumber=${partNumber}&uploadId=${fileUpload.uploadId}`,
          {
            method: 'PUT',
            body: chunkBody,
          }
        );

        if (!uploadResponse.ok) {
          const errorText = await uploadResponse.text();
          const error = new Error(`分块上传失败: ${errorText}`);
          error.statusCode = uploadResponse.status;
          throw error;
        }

        const uploadEtag = uploadResponse.headers.get('etag');
        return { response: uploadResponse, etag: uploadEtag };
      },
      CONFIG.MAX_RETRY_ATTEMPTS,
      `Upload chunk ${partNumber} for ${fileName}`
    );

    // 🔧 修复竞态条件：为每个 chunk 单独存储 KV 记录
    // 避免并发修改同一个元数据对象
    const chunkKey = `upload:${uploadId}:chunk:${fileName}:${chunkIndex}`;
    await env.FILE_META.put(chunkKey, JSON.stringify({
      partNumber,
      etag,
      fileName,
      chunkIndex,
      uploadedAt: Date.now()
    }));

    requestLogger.info('Chunk uploaded and recorded', {
      uploadId,
      fileName,
      chunkIndex,
      partNumber
    });

    // 计算总体进度（从独立的 chunk 记录中统计）
    const totalChunks = meta.files.reduce((sum, f) => sum + f.totalChunks, 0);
    let uploadedCount = 0;

    // 统计已上传的 chunks
    for (const file of meta.files) {
      for (let i = 0; i < file.totalChunks; i++) {
        const key = `upload:${uploadId}:chunk:${file.name}:${i}`;
        const exists = await env.FILE_META.get(key);
        if (exists) uploadedCount++;
      }
    }

    const progress = (uploadedCount / totalChunks) * 100;

    return jsonResponse({
      success: true,
      uploaded: uploadedCount,
      total: totalChunks,
      overallProgress: progress
    });

  } catch (error) {
    console.error('Chunk upload error:', error);
    return errorResponse('分块上传失败: ' + error.message, 500);
  }
}

/**
 * 完成上传并触发压缩
 */
async function handleUploadComplete(request, env, ctx, logger, metrics) {
  const requestLogger = logger ? logger.child({ handler: 'upload.complete' }) : { info: () => { }, error: () => { } };

  try {
    const { uploadId } = await request.json();

    // 获取上传元数据
    const metaStr = await env.FILE_META.get(`upload:${uploadId}`);
    if (!metaStr) {
      return errorResponse('上传不存在', 404);
    }

    const meta = JSON.parse(metaStr);

    // 🔧 从独立的 chunk KV 记录中读取所有 chunks
    // 验证所有文件的所有分块都已上传
    const filesStatus = [];

    for (const fileUpload of meta.files) {
      const chunks = [];

      // 读取该文件的所有 chunk 记录
      for (let i = 0; i < fileUpload.totalChunks; i++) {
        const chunkKey = `upload:${uploadId}:chunk:${fileUpload.name}:${i}`;
        const chunkDataStr = await env.FILE_META.get(chunkKey);

        if (chunkDataStr) {
          const chunkData = JSON.parse(chunkDataStr);
          chunks.push(chunkData);
        }
      }

      filesStatus.push({
        name: fileUpload.name,
        uploadedChunks: chunks.length,
        totalChunks: fileUpload.totalChunks
      });

      // 保存 chunks 到 fileUpload 对象，用于后续完成 multipart upload
      fileUpload.chunks = chunks;
    }

    requestLogger.info('Upload complete request', {
      uploadId,
      filesCount: meta.files.length,
      files: filesStatus
    });

    // 验证所有文件的所有分块都已上传
    for (const fileUpload of meta.files) {
      if (fileUpload.chunks.length !== fileUpload.totalChunks) {
        requestLogger.error('File incomplete', {
          fileName: fileUpload.name,
          uploadedChunks: fileUpload.chunks.length,
          totalChunks: fileUpload.totalChunks,
          missing: fileUpload.totalChunks - fileUpload.chunks.length
        });
        if (metrics) metrics.increment('upload.complete.incomplete', 1);
        return errorResponse(`文件 ${fileUpload.name} 未完全上传: ${fileUpload.chunks.length}/${fileUpload.totalChunks} chunks`);
      }
    }

    requestLogger.info('All chunks verified, completing multipart upload');

    // 初始化aws4fetch客户端
    const awsClient = getAwsClient(env);
    const r2Url = getR2Url(env);

    // 完成所有文件的multipart upload
    for (const fileUpload of meta.files) {
      // 按partNumber排序
      const sortedParts = fileUpload.chunks.sort((a, b) => a.partNumber - b.partNumber);

      // 调试：打印所有 parts 信息
      console.log(`📦 [Complete] File: ${fileUpload.name}, Total parts: ${sortedParts.length}`);
      sortedParts.forEach(part => {
        console.log(`  Part ${part.partNumber}: ETag=${part.etag}, ChunkIndex=${part.chunkIndex}`);
      });

      // 构建XML body
      const partsXml = sortedParts
        .map(part => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag}</ETag></Part>`)
        .join('');
      const xmlBody = `<CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`;

      console.log(`📝 [Complete] XML Body length: ${xmlBody.length} bytes`);
      console.log(`📝 [Complete] First 500 chars: ${xmlBody.substring(0, 500)}`);

      // 使用重试机制完成multipart upload
      await retryWithBackoff(
        async () => {
          const completeResponse = await awsClient.fetch(
            `${r2Url}/${fileUpload.key}?uploadId=${fileUpload.uploadId}`,
            {
              method: 'POST',
              body: xmlBody,
              headers: {
                'Content-Type': 'application/xml',
              },
            }
          );

          if (!completeResponse.ok) {
            const errorText = await completeResponse.text();
            console.error(`❌ [Complete] Error response (${completeResponse.status}): ${errorText}`);
            const error = new Error(`完成multipart upload失败: ${errorText}`);
            error.statusCode = completeResponse.status;
            throw error;
          }

          console.log(`✅ [Complete] Multipart upload completed successfully for ${fileUpload.name}`);
          return completeResponse;
        },
        CONFIG.MAX_RETRY_ATTEMPTS,
        `Complete multipart upload for ${fileUpload.name}`
      );
    }

    // 更新状态
    meta.status = 'uploaded';
    meta.uploadedAt = Date.now();
    await env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(meta));

    // 如果是单个zip文件，直接移动到最终位置
    if (meta.isSingleZip) {
      const fileId = generateFileId();
      const fileUpload = meta.files[0];

      // 复制文件到最终位置
      await env.FILE_STORAGE.put(fileId, (await env.FILE_STORAGE.get(fileUpload.key)).body);

      // 删除临时文件
      await env.FILE_STORAGE.delete(fileUpload.key);

      // 保存元数据
      const metadata = {
        fileId,
        password: meta.password,
        expiryTime: getExpiryTime(),
        createdAt: Date.now(),
        fileName: fileUpload.name,
        fileSize: fileUpload.size,
      };

      await env.FILE_META.put(fileId, JSON.stringify(metadata));

      // 更新上传状态
      meta.status = 'completed';
      meta.fileId = fileId;
      await env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(meta));

      return jsonResponse({
        success: true,
        status: 'completed',
        fileId,
        downloadUrl: `/d/${fileId}`
      });
    }

    // 触发压缩任务
    console.log(`🚀 [handleUploadComplete] Triggering compression task for uploadId: ${uploadId}`);
    const compressionPromise = performCompression(uploadId, meta, env);
    ctx.waitUntil(compressionPromise);
    console.log(`✅ [handleUploadComplete] Compression task scheduled with ctx.waitUntil()`);

    return jsonResponse({
      success: true,
      status: 'compressing',
      message: '开始压缩'
    });

  } catch (error) {
    console.error('Complete error:', error);
    return errorResponse('完成失败: ' + error.message, 500);
  }
}

/**
 * 查询上传状态
 */
async function handleUploadStatus(uploadId, env) {
  try {
    // 先检查内存中的进度
    if (compressionProgress.has(uploadId)) {
      const progress = compressionProgress.get(uploadId);
      return jsonResponse({
        success: true,
        ...progress,
      });
    }

    // 从KV中查询
    const uploadMetaStr = await env.FILE_META.get(`upload:${uploadId}`);
    if (!uploadMetaStr) {
      return errorResponse('上传不存在', 404);
    }

    const uploadMeta = JSON.parse(uploadMetaStr);

    if (uploadMeta.status === 'completed') {
      return jsonResponse({
        success: true,
        status: 'completed',
        progress: 100,
        fileId: uploadMeta.fileId,
        downloadUrl: `/d/${uploadMeta.fileId}`,
      });
    }

    if (uploadMeta.status === 'failed') {
      return jsonResponse({
        success: false,
        status: 'failed',
        error: uploadMeta.error || '处理失败',
      });
    }

    return jsonResponse({
      success: true,
      status: uploadMeta.status,
      progress: uploadMeta.status === 'compressing' ? 50 : 0,
    });

  } catch (error) {
    console.error('Status error:', error);
    return errorResponse('查询状态失败: ' + error.message, 500);
  }
}

/**
 * 执行实际的压缩操作
 * 🔧 使用流式压缩避免内存溢出
 * 🔧 智能环境检测：生产环境用 R2 binding，本地开发用 S3 API
 */
async function performCompression(uploadId, uploadMeta, env) {
  console.log(`🔄 [Compression] Starting compression for uploadId: ${uploadId}`);

  try {
    uploadMeta.status = 'compressing';
    await env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(uploadMeta));
    console.log(`✅ [Compression] Status updated to 'compressing'`);

    // 🎯 单个 ZIP 文件优化：直接存储不压缩
    // 其他情况（单个非 zip 文件、多个文件）都需要压缩
    const isSingleZipFile = uploadMeta.files.length === 1 &&
      uploadMeta.files[0].name.toLowerCase().endsWith('.zip');

    if (isSingleZipFile) {
      console.log(`📦 [Compression] Single ZIP file detected, skipping compression`);
      return await handleSingleFile(uploadId, uploadMeta, env);
    }

    // 其他情况：使用流式压缩
    if (uploadMeta.files.length === 1) {
      console.log(`📄 [Compression] Single non-ZIP file detected, compressing...`);
    } else {
      console.log(`📁 [Compression] Multiple files detected, compressing...`);
    }
    return await handleMultipleFiles(uploadId, uploadMeta, env);

  } catch (error) {
    console.error(`❌ [Compression] Error:`, error);
    uploadMeta.status = 'failed';
    uploadMeta.error = error.message;
    await env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(uploadMeta));
    compressionProgress.delete(uploadId);
    throw error;
  }
}

/**
 * 处理单文件上传（直接存储不压缩）
 */
async function handleSingleFile(uploadId, uploadMeta, env) {
  const fileInfo = uploadMeta.files[0];
  console.log(`📂 [SingleFile] Processing: ${fileInfo.name}`);

  let useS3API = false;
  const awsClient = getAwsClient(env);
  const r2Url = getR2Url(env);

  // 读取文件
  let fileData;
  try {
    const r2Object = await env.FILE_STORAGE.get(fileInfo.key);
    if (r2Object) {
      fileData = await r2Object.arrayBuffer();
      console.log(`✅ [SingleFile] Read via R2 binding: ${fileData.byteLength} bytes`);
    } else {
      useS3API = true;
    }
  } catch (error) {
    console.log(`⚠️ [SingleFile] R2 binding failed, using S3 API`);
    useS3API = true;
  }

  if (useS3API || !fileData) {
    const response = await awsClient.fetch(`${r2Url}/${fileInfo.key}`);
    if (!response.ok) {
      throw new Error(`文件不存在: ${fileInfo.name}`);
    }
    fileData = await response.arrayBuffer();
    console.log(`✅ [SingleFile] Read via S3 API: ${fileData.byteLength} bytes`);
  }

  // 生成文件ID并存储
  const fileId = generateFileId();
  const expiryTime = getExpiryTime();

  await env.FILE_STORAGE.put(fileId, fileData);
  console.log(`✅ [SingleFile] Saved with ID: ${fileId}`);

  // 保存元数据
  const metadata = {
    fileId,
    fileName: fileInfo.name,
    password: uploadMeta.password,
    expiryTime,
    uploadedAt: Date.now(),
    fileCount: 1,
    fileSize: fileData.byteLength,
  };

  await env.FILE_META.put(fileId, JSON.stringify(metadata));

  // 更新上传状态
  uploadMeta.status = 'completed';
  uploadMeta.fileId = fileId;
  await env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(uploadMeta));

  // 删除临时文件
  await env.FILE_STORAGE.delete(fileInfo.key);

  compressionProgress.delete(uploadId);
  console.log(`🎉 [SingleFile] Completed: ${fileId}`);

  return fileId;
}

/**
 * 处理多文件：GB级别流式压缩
 * - 分块读取：每次读取10MB避免内存溢出
 * - 流式压缩：使用 fflate Zip 流式 API
 * - 分块写入：使用 R2 Multipart Upload 边生成边上传
 */
async function handleMultipleFiles(uploadId, uploadMeta, env) {
  console.log(`🗜️ [MultiFile] Starting GB-scale streaming compression for ${uploadMeta.files.length} files`);

  const CHUNK_READ_SIZE = 10 * 1024 * 1024; // 10MB 分块读取
  const awsClient = getAwsClient(env);
  const r2Url = getR2Url(env);

  // 🎯 准备 R2 Multipart Upload 用于写入最终 ZIP
  const fileId = generateFileId();
  const expiryTime = getExpiryTime();

  console.log(`🚀 [MultiFile] Initializing R2 Multipart Upload for final ZIP: ${fileId}`);
  const uploadIdForZip = await initMultipartUpload(fileId, awsClient, r2Url);

  const uploadedParts = [];
  let currentChunkBuffer = [];
  let currentChunkSize = 0;
  let partNumber = 1;

  // 🔧 R2 严格要求：除最后一个 part 外，所有 parts 必须大小完全相同
  const STANDARD_PART_SIZE = 50 * 1024 * 1024; // 50MB - 标准 part 大小
  const MIN_PART_SIZE = 5 * 1024 * 1024; // 5MB - R2 最小要求（仅用于最后一个 part）

  // 🎯 创建流式 ZIP 生成器（边生成边上传到 R2）
  let zipError = null;
  let zipFinalized = false;
  let pendingUploads = [];  // 🔧 收集所有待处理的上传 Promise

  const zipStream = new Zip((err, chunk, final) => {
    if (err) {
      console.error(`❌ [MultiFile] ZIP stream error:`, err);
      zipError = err;
      return;
    }

    if (chunk && chunk.byteLength > 0) {
      console.log(`📦 [MultiFile] ZIP chunk generated: ${chunk.byteLength} bytes`);

      // 累积 chunk 到缓冲区
      currentChunkBuffer.push(chunk);
      currentChunkSize += chunk.byteLength;

      // 🔧 当缓冲区 >= STANDARD_PART_SIZE 时，上传精确大小的 part
      // 这确保所有非最后一个 part 的大小完全相同
      while (currentChunkSize >= STANDARD_PART_SIZE) {
        // 合并所有 chunks
        const allData = mergeUint8Arrays(currentChunkBuffer);

        // 取出精确的 STANDARD_PART_SIZE
        const partData = allData.slice(0, STANDARD_PART_SIZE);
        const remainingData = allData.slice(STANDARD_PART_SIZE);

        const currentPartNumber = partNumber++;
        console.log(`⬆️ [MultiFile] Uploading part ${currentPartNumber}: ${partData.byteLength} bytes (standard size)`);

        // 🔧 创建上传 Promise 并收集起来
        const uploadPromise = (async () => {
          try {
            const etag = await uploadPart(fileId, uploadIdForZip, currentPartNumber, partData, awsClient, r2Url);
            uploadedParts.push({ PartNumber: currentPartNumber, ETag: etag, Size: partData.byteLength });
          } catch (error) {
            console.error(`❌ [MultiFile] Failed to upload part ${currentPartNumber}:`, error);
            zipError = error;
          }
        })();
        pendingUploads.push(uploadPromise);

        // 剩余数据放回缓冲区
        if (remainingData.byteLength > 0) {
          currentChunkBuffer = [remainingData];
          currentChunkSize = remainingData.byteLength;
        } else {
          currentChunkBuffer = [];
          currentChunkSize = 0;
        }
      }
    }

    if (final) {
      console.log(`✅ [MultiFile] ZIP stream finalized`);

      // 上传最后的缓冲区（如果有）
      // 最后一个 part 可以小于 STANDARD_PART_SIZE
      if (currentChunkSize > 0) {
        const partData = mergeUint8Arrays(currentChunkBuffer);
        const currentPartNumber = partNumber++;
        console.log(`⬆️ [MultiFile] Uploading final part ${currentPartNumber}: ${partData.byteLength} bytes`);

        // 🔧 创建上传 Promise 并收集起来
        const uploadPromise = (async () => {
          try {
            const etag = await uploadPart(fileId, uploadIdForZip, currentPartNumber, partData, awsClient, r2Url);
            uploadedParts.push({ PartNumber: currentPartNumber, ETag: etag, Size: partData.byteLength });
          } catch (error) {
            console.error(`❌ [MultiFile] Failed to upload final part ${currentPartNumber}:`, error);
            zipError = error;
          }
        })();
        pendingUploads.push(uploadPromise);
      }

      // 🔧 等待所有上传完成后再设置 zipFinalized = true
      Promise.all(pendingUploads)
        .then(() => {
          console.log(`✅ [MultiFile] All ${pendingUploads.length} parts uploaded successfully`);
          zipFinalized = true;
        })
        .catch((error) => {
          console.error(`❌ [MultiFile] Failed to upload parts:`, error);
          zipError = error;
          zipFinalized = true;  // 即使失败也要设置，以便外层检测到错误
        });
    }
  });

  // 🔄 逐个文件分块读取并流式压缩
  let processedCount = 0;

  for (const fileInfo of uploadMeta.files) {
    console.log(`🔍 [MultiFile] Processing file ${processedCount + 1}/${uploadMeta.files.length}: ${fileInfo.name}`);

    compressionProgress.set(uploadId, {
      status: 'reading',
      progress: Math.round((processedCount / uploadMeta.files.length) * 80),
      currentFile: fileInfo.name,
      processedCount,
      totalCount: uploadMeta.files.length,
    });

    // 🗜️ 创建文件流（不压缩，level=0）
    const fileStream = new ZipPassThrough(fileInfo.name);
    zipStream.add(fileStream);

    // 📖 获取文件大小
    let fileSize;
    try {
      const headResponse = await awsClient.fetch(`${r2Url}/${fileInfo.key}`, { method: 'HEAD' });
      fileSize = parseInt(headResponse.headers.get('content-length') || '0');
      console.log(`📏 [MultiFile] File size: ${fileSize} bytes`);
    } catch (error) {
      console.warn(`⚠️ [MultiFile] Failed to get file size, will read in one go`);
      fileSize = null;
    }

    // 🔄 分块读取文件并推送到压缩流
    if (fileSize && fileSize > CHUNK_READ_SIZE) {
      // 大文件：分块读取
      let offset = 0;
      while (offset < fileSize) {
        const end = Math.min(offset + CHUNK_READ_SIZE - 1, fileSize - 1);
        console.log(`📖 [MultiFile] Reading chunk: bytes ${offset}-${end}`);

        const response = await awsClient.fetch(`${r2Url}/${fileInfo.key}`, {
          headers: { Range: `bytes=${offset}-${end}` },
        });

        if (!response.ok) {
          throw new Error(`Failed to read file chunk: ${response.status}`);
        }

        const chunkData = new Uint8Array(await response.arrayBuffer());
        const isFinal = (end >= fileSize - 1);

        fileStream.push(chunkData, isFinal);
        console.log(`✅ [MultiFile] Pushed ${chunkData.byteLength} bytes to ZIP stream (final: ${isFinal})`);

        offset = end + 1;
      }
    } else {
      // 小文件：一次读取
      const response = await awsClient.fetch(`${r2Url}/${fileInfo.key}`);
      if (!response.ok) {
        throw new Error(`文件不存在: ${fileInfo.name}`);
      }

      const fileData = new Uint8Array(await response.arrayBuffer());
      fileStream.push(fileData, true);
      console.log(`✅ [MultiFile] Pushed entire file (${fileData.byteLength} bytes) to ZIP stream`);
    }

    // 🗑️ 立即删除临时文件
    try {
      await env.FILE_STORAGE.delete(fileInfo.key);
      console.log(`🗑️ [MultiFile] Deleted temp file: ${fileInfo.key}`);
    } catch (error) {
      console.warn(`⚠️ [MultiFile] Failed to delete temp file: ${fileInfo.key}`);
    }

    processedCount++;

    if (zipError) {
      throw new Error(`ZIP stream error: ${zipError.message}`);
    }
  }

  console.log(`ℹ️ [MultiFile] All ${uploadMeta.files.length} files added to ZIP stream`);

  // 🏁 结束 ZIP 流
  zipStream.end();
  console.log(`🏁 [MultiFile] ZIP stream ended, waiting for finalization...`);

  // ⏳ 等待 ZIP 流完成
  const maxWait = 60000; // 60秒超时
  const startTime = Date.now();
  while (!zipFinalized && !zipError && (Date.now() - startTime) < maxWait) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  if (zipError) {
    await abortMultipartUpload(fileId, uploadIdForZip, awsClient, r2Url);
    throw new Error(`压缩失败: ${zipError.message || zipError}`);
  }

  if (!zipFinalized) {
    await abortMultipartUpload(fileId, uploadIdForZip, awsClient, r2Url);
    throw new Error('压缩超时');
  }

  // ✅ 完成 R2 Multipart Upload
  compressionProgress.set(uploadId, {
    status: 'finalizing',
    progress: 90,
    message: '正在完成上传...',
  });

  console.log(`🏁 [MultiFile] Completing R2 Multipart Upload with ${uploadedParts.length} parts`);
  await completeMultipartUpload(fileId, uploadIdForZip, uploadedParts, awsClient, r2Url);
  console.log(`✅ [MultiFile] R2 Multipart Upload completed: ${fileId}`);

  // 💾 保存元数据
  const totalSize = uploadedParts.reduce((sum, part) => sum + part.Size || 0, 0);
  const metadata = {
    fileId,
    fileName: 'files.zip',
    password: uploadMeta.password,
    expiryTime,
    uploadedAt: Date.now(),
    fileCount: uploadMeta.files.length,
    fileSize: totalSize,
  };

  await env.FILE_META.put(fileId, JSON.stringify(metadata));

  // ✅ 更新上传状态
  uploadMeta.status = 'completed';
  uploadMeta.fileId = fileId;
  await env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(uploadMeta));

  compressionProgress.delete(uploadId);
  console.log(`🎉 [MultiFile] Completed: ${fileId}`);

  return fileId;
}

/**
 * 合并多个 Uint8Array
 */
function mergeUint8Arrays(arrays) {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.byteLength;
  }
  return result;
}

/**
 * 初始化 R2 Multipart Upload
 */
async function initMultipartUpload(key, awsClient, r2Url) {
  const url = `${r2Url}/${key}?uploads`;

  const response = await awsClient.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to init multipart upload: ${response.status} ${error}`);
  }

  const xmlText = await response.text();
  const uploadIdMatch = xmlText.match(/<UploadId>([^<]+)<\/UploadId>/);

  if (!uploadIdMatch) {
    throw new Error('Failed to extract UploadId from response');
  }

  const uploadId = uploadIdMatch[1];
  console.log(`🚀 [Multipart] Initialized upload: ${uploadId}`);

  return uploadId;
}

/**
 * 上传单个 part
 */
async function uploadPart(key, uploadId, partNumber, data, awsClient, r2Url) {
  const url = `${r2Url}/${key}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`;

  const response = await awsClient.fetch(url, {
    method: 'PUT',
    body: data,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': data.byteLength.toString(),
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to upload part ${partNumber}: ${response.status} ${error}`);
  }

  const etag = response.headers.get('etag');
  if (!etag) {
    throw new Error(`No ETag returned for part ${partNumber}`);
  }

  console.log(`✅ [Multipart] Uploaded part ${partNumber}: ${etag}`);
  return etag;
}

/**
 * 完成 R2 Multipart Upload
 */
async function completeMultipartUpload(key, uploadId, parts, awsClient, r2Url) {
  const url = `${r2Url}/${key}?uploadId=${encodeURIComponent(uploadId)}`;

  // 构造 XML body
  const xmlParts = parts.map(part =>
    `<Part><PartNumber>${part.PartNumber}</PartNumber><ETag>${part.ETag}</ETag></Part>`
  ).join('');

  const xmlBody = `<CompleteMultipartUpload>${xmlParts}</CompleteMultipartUpload>`;

  const response = await awsClient.fetch(url, {
    method: 'POST',
    body: xmlBody,
    headers: {
      'Content-Type': 'application/xml',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to complete multipart upload: ${response.status} ${error}`);
  }

  console.log(`🎉 [Multipart] Completed upload: ${key}`);
  return await response.text();
}

/**
 * 中止 R2 Multipart Upload
 */
async function abortMultipartUpload(key, uploadId, awsClient, r2Url) {
  const url = `${r2Url}/${key}?uploadId=${encodeURIComponent(uploadId)}`;

  const response = await awsClient.fetch(url, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`⚠️ [Multipart] Failed to abort upload: ${response.status} ${error}`);
  } else {
    console.log(`🗑️ [Multipart] Aborted upload: ${uploadId}`);
  }
}

/**
 * 验证密码
 */
async function handleVerify(request, env) {
  try {
    const { fileId, password } = await request.json();

    if (!fileId || !password) {
      return errorResponse('缺少文件ID或密码');
    }

    // 获取文件元数据
    const metadataStr = await env.FILE_META.get(fileId);

    if (!metadataStr) {
      return errorResponse('文件不存在或已过期', 404);
    }

    const metadata = JSON.parse(metadataStr);

    // 检查是否过期
    if (isExpired(metadata.expiryTime)) {
      // 删除过期文件
      await deleteFile(fileId, env);
      return errorResponse('文件已过期', 410);
    }

    // 验证密码
    const isValid = await verifyPassword(password, metadata.password);

    if (!isValid) {
      return errorResponse('密码错误', 401);
    }

    // 使用哈希后的密码生成令牌
    const downloadToken = await generateDownloadToken(fileId, metadata.password);

    return jsonResponse({
      success: true,
      fileId,
      fileName: metadata.fileName,
      fileSize: metadata.fileSize,
      downloadUrl: `/api/download/${fileId}?token=${downloadToken}`,
    });

  } catch (error) {
    console.error('Verify error:', error);
    return errorResponse('验证失败: ' + error.message, 500);
  }
}

/**
 * 处理文件下载
 */
async function handleDownload(fileId, request, env) {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    if (!token) {
      return errorResponse('缺少下载令牌', 401);
    }

    // 获取文件元数据
    const metadataStr = await env.FILE_META.get(fileId);

    if (!metadataStr) {
      return errorResponse('文件不存在', 404);
    }

    const metadata = JSON.parse(metadataStr);

    // 检查是否过期
    if (isExpired(metadata.expiryTime)) {
      await deleteFile(fileId, env);
      return errorResponse('文件已过期', 410);
    }

    // 验证令牌
    const expectedToken = await generateDownloadToken(fileId, metadata.password);
    if (token !== expectedToken) {
      return errorResponse('无效的下载令牌', 401);
    }

    // 🔧 从R2获取文件（智能选择访问方式）
    // 策略：优先使用原生 R2 Binding（生产环境），如果失败则使用 aws4fetch（本地开发环境）

    console.log(`📥 [Download] Attempting to fetch file: ${fileId}`);

    // 方案1：尝试使用原生 R2 Binding（生产环境最优）
    try {
      const object = await env.FILE_STORAGE.get(fileId);

      if (object) {
        console.log(`✅ [Download] File fetched via R2 Binding (production mode)`);
        return new Response(object.body, {
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(metadata.fileName)}"`,
            'Content-Length': metadata.fileSize.toString(),
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      console.log(`⚠️ [Download] R2 Binding returned null, trying aws4fetch...`);
    } catch (error) {
      console.log(`⚠️ [Download] R2 Binding failed: ${error.message}, trying aws4fetch...`);
    }

    // 方案2：使用 aws4fetch 访问远程 R2（本地开发环境 fallback）
    try {
      const awsClient = getAwsClient(env);
      const r2Url = getR2Url(env);
      const downloadUrl = `${r2Url}/${fileId}`;

      console.log(`🔄 [Download] Fetching via aws4fetch (dev mode): ${downloadUrl}`);

      const response = await awsClient.fetch(downloadUrl, {
        method: 'GET',
      });

      if (response.ok) {
        console.log(`✅ [Download] File fetched via aws4fetch`);
        return new Response(response.body, {
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(metadata.fileName)}"`,
            'Content-Length': metadata.fileSize.toString(),
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      console.error(`❌ [Download] aws4fetch failed: ${response.status} ${response.statusText}`);
    } catch (error) {
      console.error(`❌ [Download] aws4fetch error: ${error.message}`);
    }

    // 两种方式都失败了
    return errorResponse('文件数据不存在', 404);

  } catch (error) {
    console.error('Download error:', error);
    return errorResponse('下载失败: ' + error.message, 500);
  }
}

/**
 * 生成下载令牌
 */
async function generateDownloadToken(fileId, hashedPassword) {
  const data = `${fileId}:${hashedPassword}`;
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

/**
 * 删除文件和元数据
 */
async function deleteFile(fileId, env) {
  try {
    await env.FILE_STORAGE.delete(fileId);
    await env.FILE_META.delete(fileId);
  } catch (error) {
    console.error('Delete error:', error);
  }
}

/**
 * 清理过期文件（定时任务）
 */
async function cleanupExpiredFiles(env) {
  try {
    const list = await env.FILE_META.list();
    let deletedCount = 0;

    for (const key of list.keys) {
      // 跳过上传元数据
      if (key.name.startsWith('upload:')) {
        continue;
      }

      const metadataStr = await env.FILE_META.get(key.name);
      if (!metadataStr) continue;

      const metadata = JSON.parse(metadataStr);

      if (isExpired(metadata.expiryTime)) {
        await deleteFile(key.name, env);
        deletedCount++;
      }
    }

    console.log(`Cleaned up ${deletedCount} expired files`);
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

/**
 * 渲染上传页面（R2 Multipart Upload版本）
 */
async function serveUploadPage() {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FastFile - 大文件中转</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }

    .container {
      background: white;
      border-radius: 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      padding: 40px;
      max-width: 600px;
      width: 100%;
    }

    h1 {
      text-align: center;
      color: #333;
      margin-bottom: 10px;
      font-size: 32px;
    }

    .subtitle {
      text-align: center;
      color: #666;
      margin-bottom: 30px;
      font-size: 14px;
    }

    .upload-area {
      border: 3px dashed #667eea;
      border-radius: 10px;
      padding: 40px;
      text-align: center;
      cursor: pointer;
      transition: all 0.3s;
      margin-bottom: 20px;
      background: #f8f9ff;
    }

    .upload-area:hover {
      border-color: #764ba2;
      background: #f0f2ff;
    }

    .upload-area.dragover {
      border-color: #764ba2;
      background: #e8ebff;
      transform: scale(1.02);
    }

    .upload-icon {
      font-size: 48px;
      margin-bottom: 10px;
      color: #667eea;
    }

    .file-input {
      display: none;
    }

    .selected-files {
      margin: 20px 0;
      padding: 15px;
      background: #f8f9ff;
      border-radius: 8px;
      display: none;
    }

    .selected-files.show {
      display: block;
    }

    .file-list {
      max-height: 200px;
      overflow-y: auto;
      margin-top: 10px;
    }

    .file-item {
      padding: 8px;
      background: white;
      margin-bottom: 5px;
      border-radius: 5px;
      font-size: 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .file-item .file-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-right: 10px;
    }

    .file-item .file-size {
      color: #666;
      font-size: 12px;
    }

    .password-group {
      margin-bottom: 20px;
    }

    .password-group label {
      display: block;
      margin-bottom: 8px;
      color: #333;
      font-weight: 500;
    }

    .password-input-group {
      display: flex;
      gap: 10px;
    }

    input[type="text"] {
      flex: 1;
      padding: 12px 15px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 16px;
      transition: all 0.3s;
    }

    input[type="text"]:focus {
      outline: none;
      border-color: #667eea;
    }

    input[type="text"]:disabled {
      background: #f8f9ff;
      border-color: #667eea;
      color: #667eea;
      font-weight: 600;
      cursor: not-allowed;
    }

    button {
      padding: 12px 24px;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      cursor: pointer;
      transition: all 0.3s;
      font-weight: 500;
    }

    .btn-primary {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      width: 100%;
    }

    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
    }

    .btn-primary:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }

    .btn-secondary {
      background: #f0f0f0;
      color: #333;
    }

    .btn-secondary:hover {
      background: #e0e0e0;
    }

    .btn-cancel {
      background: #ff4757;
      color: white;
      display: none;
      margin-top: 10px;
      width: 100%;
    }

    .btn-cancel.show {
      display: block;
    }

    .btn-cancel:hover {
      background: #ff3838;
    }

    .progress-container {
      margin-top: 20px;
      display: none;
    }

    .progress-container.show {
      display: block;
    }

    .progress-bar-wrapper {
      background: #f0f0f0;
      border-radius: 10px;
      overflow: hidden;
      height: 30px;
      margin-bottom: 10px;
    }

    .progress-bar {
      height: 100%;
      background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
      transition: width 0.3s;
    }

    .progress-info {
      font-size: 14px;
      color: #666;
      line-height: 1.6;
    }

    .progress-phase {
      font-weight: bold;
      color: #333;
      margin-bottom: 5px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .progress-phase .spinner {
      display: inline-block;
      animation: spinner-rotate 1s linear infinite;
    }

    @keyframes spinner-rotate {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    .progress-details {
      color: #666;
    }

    .progress-speed,
    .progress-time {
      color: #999;
      font-size: 13px;
    }

    .result {
      margin-top: 20px;
      padding: 15px;
      border-radius: 8px;
      display: none;
      animation: fadeIn 0.3s;
    }

    .result.show {
      display: block;
    }

    .result.success {
      background: #d4edda;
      border: 1px solid #c3e6cb;
      color: #155724;
    }

    .result.error {
      background: #f8d7da;
      border: 1px solid #f5c6cb;
      color: #721c24;
    }

    .url-container {
      margin-top: 15px;
      padding: 12px;
      background: #f8f9ff;
      border-radius: 8px;
    }

    .url-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 15px;
    }

    .url-text {
      flex: 1;
      font-family: 'Monaco', 'Courier New', monospace;
      font-size: 13px;
      color: #667eea;
      word-break: break-all;
      padding: 8px;
      background: white;
      border-radius: 4px;
    }

    .copy-btn {
      flex-shrink: 0;
      padding: 8px 12px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      transition: all 0.2s;
      white-space: nowrap;
    }

    .copy-btn:hover {
      background: #5568d3;
    }

    .copy-btn.copied {
      background: #28a745;
    }

    .password-reminder {
      padding: 10px;
      background: #fff3cd;
      border: 2px solid #ffc107;
      border-radius: 6px;
      text-align: center;
      font-size: 14px;
      color: #856404;
    }

    .password-value {
      font-size: 32px;
      font-weight: bold;
      color: #d63384;
      font-family: 'Monaco', 'Courier New', monospace;
      margin: 10px 0;
      letter-spacing: 4px;
      background: linear-gradient(135deg, #ffeaa7 0%, #fdcb6e 100%);
      padding: 15px 25px;
      border-radius: 10px;
      box-shadow: 0 4px 15px rgba(214, 51, 132, 0.2);
      cursor: pointer;
      transition: all 0.3s ease;
      display: inline-block;
      user-select: none;
      position: relative;
    }

    .password-value:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(214, 51, 132, 0.3);
      background: linear-gradient(135deg, #fdcb6e 0%, #ffeaa7 100%);
    }

    .password-value:active {
      transform: translateY(0);
    }

    .password-value::after {
      content: '点击复制';
      position: absolute;
      bottom: -20px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 11px;
      color: #856404;
      opacity: 0;
      transition: opacity 0.3s ease;
      white-space: nowrap;
    }

    .password-value:hover::after {
      opacity: 1;
    }

    .btn-next-upload {
      width: 100%;
      padding: 12px;
      margin-top: 15px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 16px;
      font-weight: 500;
      transition: all 0.3s;
    }

    .btn-next-upload:hover {
      transform: translateY(-2px);
      box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
    }

    .download-link {
      display: inline-block;
      margin-top: 10px;
      padding: 10px 20px;
      background: #28a745;
      color: white;
      text-decoration: none;
      border-radius: 5px;
      transition: background 0.3s;
    }

    .download-link:hover {
      background: #218838;
    }

    .warning-banner {
      background: #fff3cd;
      border: 1px solid #ffc107;
      color: #856404;
      padding: 12px;
      border-radius: 8px;
      margin-top: 15px;
      display: none;
      font-size: 14px;
      text-align: center;
    }

    .warning-banner.show {
      display: block;
    }

    @keyframes fadeIn {
      from {
        opacity: 0;
        transform: translateY(-10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @media (max-width: 600px) {
      .container {
        padding: 20px;
      }

      h1 {
        font-size: 24px;
      }

      .upload-area {
        padding: 30px 20px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>⚡ FastFile</h1>
    <p class="subtitle">快速、安全的大文件中转服务</p>

    <form id="uploadForm">
      <div class="upload-area" id="uploadArea">
        <div class="upload-icon">📁</div>
        <p>点击或拖拽文件到这里</p>
        <p style="font-size: 12px; color: #999; margin-top: 10px;">支持多文件上传，最大10GB</p>
      </div>

      <input type="file" id="fileInput" class="file-input" multiple>

      <div class="selected-files" id="selectedFiles">
        <strong>已选择的文件：</strong>
        <div class="file-list" id="fileList"></div>
      </div>

      <div class="password-group">
        <label for="password">4位数字密码：</label>
        <div class="password-input-group">
          <input type="text" id="password" placeholder="输入4位数字" maxlength="4" pattern="\\d{4}" required>
          <button type="button" class="btn-secondary" id="regenerateBtn">重新生成</button>
        </div>
      </div>

      <button type="submit" class="btn-primary" id="uploadBtn">开始上传</button>
      <button type="button" class="btn-cancel" id="cancelBtn">取消上传</button>
    </form>

    <div class="progress-container" id="progressContainer">
      <div class="progress-bar-wrapper">
        <div class="progress-bar" id="progressBar">0%</div>
      </div>
      <div class="progress-info">
        <div class="progress-phase" id="progressPhase">准备中...</div>
        <div class="progress-details" id="progressDetails"></div>
        <div class="progress-speed" id="progressSpeed"></div>
        <div class="progress-time" id="progressTime"></div>
      </div>
    </div>

    <div class="warning-banner" id="warningBanner">
      ⚠️ 上传过程中请勿关闭此页面
    </div>

    <div class="result" id="result"></div>
  </div>

  <script>
    const uploadForm = document.getElementById('uploadForm');
    const fileInput = document.getElementById('fileInput');
    const uploadArea = document.getElementById('uploadArea');
    const selectedFiles = document.getElementById('selectedFiles');
    const fileList = document.getElementById('fileList');
    const passwordInput = document.getElementById('password');
    const regenerateBtn = document.getElementById('regenerateBtn');
    const uploadBtn = document.getElementById('uploadBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const progressContainer = document.getElementById('progressContainer');
    const progressBar = document.getElementById('progressBar');
    const progressPhase = document.getElementById('progressPhase');
    const progressDetails = document.getElementById('progressDetails');
    const progressSpeed = document.getElementById('progressSpeed');
    const progressTime = document.getElementById('progressTime');
    const warningBanner = document.getElementById('warningBanner');
    const result = document.getElementById('result');

    let isUploading = false;
    let isSingleZip = false;
    let uploadId = null;
    let statusPollInterval = null;
    let uploadAborted = false;
    let currentPassword = '';  // 保存当前上传的密码

    // 配置常量 - 从后端同步
    const CHUNK_SIZE = ${CONFIG.CHUNK_SIZE};
    const MAX_CONCURRENT = ${CONFIG.MAX_CONCURRENT};
    const MAX_RETRY_ATTEMPTS = ${CONFIG.MAX_RETRY_ATTEMPTS};
    const RETRY_DELAY_BASE = ${CONFIG.RETRY_DELAY_BASE};

    /**
     * 判断错误是否可重试
     */
    function isRetryableError(error, response) {
      // 可重试的HTTP状态码
      const retryableStatusCodes = [408, 429, 500, 502, 503, 504];

      if (response && retryableStatusCodes.includes(response.status)) {
        return true;
      }

      // 网络错误（扩展）
      const message = (error.message || String(error)).toLowerCase();
      const retryableErrorPatterns = [
        'network',
        'timeout',
        'fetch',
        'failed to fetch',
        'connection lost',
        'connection closed',
        'socket hang up',
        'econnreset',
        'etimedout',
        'enotfound',
        'econnrefused',
        'network request failed',
        'aborted',
        'request aborted',
      ];

      for (const pattern of retryableErrorPatterns) {
        if (message.includes(pattern)) {
          return true;
        }
      }

      return false;
    }

    /**
     * 指数退避重试函数（客户端版本）
     */
    async function retryWithBackoff(fn, maxAttempts = MAX_RETRY_ATTEMPTS, operation = 'operation') {
      let lastError;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await fn();
        } catch (error) {
          lastError = error;

          // 判断是否可重试
          if (!isRetryableError(error, error.response)) {
            console.error(\`\${operation} failed with non-retryable error:\`, error);
            throw error;
          }

          // 如果是最后一次尝试，直接抛出错误
          if (attempt === maxAttempts) {
            console.error(\`\${operation} failed after \${maxAttempts} attempts:\`, error);
            throw error;
          }

          // 计算退避延迟: base * 2^(attempt-1) + random jitter
          const baseDelay = RETRY_DELAY_BASE * Math.pow(2, attempt - 1);
          const jitter = Math.random() * 1000; // 0-1秒的随机抖动
          const delay = baseDelay + jitter;

          console.warn(\`⚠️ \${operation} attempt \${attempt}/\${maxAttempts} failed (\${error.message}), retrying in \${Math.round(delay)}ms...\`);

          // 在进度详情中显示重试信息
          if (progressDetails) {
            const retryText = \`⚠️ 重试中 (\${attempt}/\${maxAttempts})...\`;
            progressDetails.textContent = retryText;
            progressDetails.style.color = '#f59e0b'; // 橙色警告
          }

          // 等待后重试
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }

      throw lastError;
    }

    // 生成随机4位数字密码
    function generatePassword() {
      return Math.floor(1000 + Math.random() * 9000).toString();
    }

    passwordInput.value = generatePassword();

    regenerateBtn.addEventListener('click', () => {
      passwordInput.value = generatePassword();
    });

    // 离开页面警告
    window.addEventListener('beforeunload', (e) => {
      if (isUploading) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    // 取消上传
    cancelBtn.addEventListener('click', () => {
      if (confirm('确定要取消上传吗？')) {
        uploadAborted = true;
        if (statusPollInterval) {
          clearInterval(statusPollInterval);
        }
        resetUpload();
      }
    });

    // 上传区域点击事件
    uploadArea.addEventListener('click', () => {
      fileInput.click();
    });

    // 文件选择事件
    fileInput.addEventListener('change', (e) => {
      handleFiles(e.target.files);
    });

    // 拖拽事件
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('dragover');
    });

    uploadArea.addEventListener('dragleave', () => {
      uploadArea.classList.remove('dragover');
    });

    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('dragover');
      handleFiles(e.dataTransfer.files);
    });

    // 处理选择的文件
    function handleFiles(files) {
      if (files.length === 0) return;

      fileList.innerHTML = '';
      let totalSize = 0;

      Array.from(files).forEach(file => {
        totalSize += file.size;
        const item = document.createElement('div');
        item.className = 'file-item';
        item.innerHTML = \`
          <span class="file-name">\${file.name}</span>
          <span class="file-size">\${formatFileSize(file.size)}</span>
        \`;
        fileList.appendChild(item);
      });

      selectedFiles.classList.add('show');

      // 检查是否为单个zip文件
      isSingleZip = files.length === 1 && files[0].name.toLowerCase().endsWith('.zip');
    }

    // 格式化文件大小
    function formatFileSize(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // 格式化速度
    function formatSpeed(bytesPerSecond) {
      return formatFileSize(bytesPerSecond) + '/s';
    }

    // 格式化时间
    function formatTime(seconds) {
      if (seconds < 60) {
        return Math.round(seconds) + '秒';
      } else if (seconds < 3600) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.round(seconds % 60);
        return mins + '分' + secs + '秒';
      } else {
        const hours = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        return hours + '小时' + mins + '分';
      }
    }

    // 更新进度条
    function updateProgress(percent, phase, details = '', speed = '', time = '') {
      progressBar.style.width = percent + '%';
      progressBar.textContent = '';  // 确保进度条内部不显示任何文本
      progressPhase.innerHTML = phase;  // 使用innerHTML以支持HTML标签
      progressDetails.textContent = details;
      progressDetails.style.color = ''; // 重置颜色（恢复默认）
      progressSpeed.textContent = speed;
      progressTime.textContent = time;
    }

    // 显示结果
    function showResult(message, type = 'success') {
      result.className = 'result show ' + type;
      result.innerHTML = message;
    }

    // 重置上传状态
    function resetUpload() {
      isUploading = false;
      uploadAborted = false;
      uploadBtn.style.display = '';
      progressContainer.classList.remove('show');
      warningBanner.classList.remove('show');
      cancelBtn.classList.remove('show');
      uploadArea.style.display = '';
      selectedFiles.style.display = '';

      // 恢复密码输入和重新生成按钮
      passwordInput.disabled = false;
      regenerateBtn.disabled = false;
      regenerateBtn.style.opacity = '1';
      regenerateBtn.style.cursor = 'pointer';
    }

    // 完成上传
    function finishUpload() {
      isUploading = false;
      warningBanner.classList.remove('show');
      cancelBtn.classList.remove('show');
    }

    // 显示成功结果
    function showSuccessResult(data) {
      const downloadUrl = data.downloadUrl || \`/d/\${data.fileId}\`;
      const fullUrl = window.location.origin + downloadUrl;

      showResult(\`
        <div class="password-reminder">
          <div>⚠️ 下载时需要输入下面的密码</div>
          <div class="password-value" onclick="copyToClipboard('\${currentPassword}', this)" title="点击复制密码">
            \${currentPassword}
          </div>
          <div style="font-size: 12px; color: #856404; margin-top: 25px;">点击复制此密码</div>
        </div>
        <div class="url-container">
          <div class="url-row">
            <div class="url-text">\${fullUrl}</div>
            <button class="copy-btn" onclick="copyToClipboard('\${fullUrl}', this)">
              📋 复制下载地址
            </button>
          </div>
        </div>
        <button class="btn-next-upload" onclick="location.reload()">
          📤 继续上传其他文件
        </button>
      \`, 'success');
    }

    // 复制到剪贴板
    window.copyToClipboard = async function(text, element) {
      try {
        await navigator.clipboard.writeText(text);
        const originalText = element.textContent;
        const isPasswordDiv = element.classList.contains('password-value');

        if (isPasswordDiv) {
          // 对于密码 div，显示临时提示而不改变密码显示
          const originalContent = element.innerHTML;
          element.innerHTML = '✓ 已复制！';
          element.style.background = 'linear-gradient(135deg, #a8e6cf 0%, #56cc9d 100%)';

          setTimeout(() => {
            element.innerHTML = originalContent;
            element.style.background = '';
          }, 1500);
        } else {
          // 对于按钮，改变文本
          element.textContent = '✓ 已复制';
          element.classList.add('copied');

          setTimeout(() => {
            element.textContent = originalText;
            element.classList.remove('copied');
          }, 2000);
        }
      } catch (err) {
        console.error('复制失败:', err);
        // 降级方案
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        document.body.appendChild(textArea);
        textArea.select();
        try {
          document.execCommand('copy');
          const isPasswordDiv = element.classList.contains('password-value');

          if (isPasswordDiv) {
            const originalContent = element.innerHTML;
            element.innerHTML = '✓ 已复制！';
            element.style.background = 'linear-gradient(135deg, #a8e6cf 0%, #56cc9d 100%)';

            setTimeout(() => {
              element.innerHTML = originalContent;
              element.style.background = '';
            }, 1500);
          } else {
            element.textContent = '✓ 已复制';
            element.classList.add('copied');
            setTimeout(() => {
              element.textContent = '📋 复制';
              element.classList.remove('copied');
            }, 2000);
          }
        } catch (err2) {
          alert('复制失败，请手动复制');
        }
        document.body.removeChild(textArea);
      }
    };

    // 上传表单提交
    uploadForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const files = fileInput.files;
      const password = passwordInput.value;

      if (files.length === 0) {
        showResult('请先选择文件', 'error');
        return;
      }

      if (!password || !/^\\d{4}$/.test(password)) {
        showResult('密码必须是4位数字', 'error');
        return;
      }

      // 保存密码用于成功后显示
      currentPassword = password;

      // 开始上传
      isUploading = true;
      uploadAborted = false;
      uploadBtn.style.display = 'none';
      progressContainer.classList.add('show');
      warningBanner.classList.add('show');
      cancelBtn.classList.add('show');
      result.classList.remove('show');

      // 隐藏上传区域、已选文件列表
      uploadArea.style.display = 'none';
      selectedFiles.style.display = 'none';

      // 禁用密码输入和重新生成按钮
      passwordInput.disabled = true;
      regenerateBtn.disabled = true;
      regenerateBtn.style.opacity = '0.5';
      regenerateBtn.style.cursor = 'not-allowed';

      // 显示初始进度
      if (isSingleZip) {
        updateProgress(0, '初始化上传...', '', '', '');
      } else {
        updateProgress(0, '初始化上传（第1阶段）', '', '', '');
      }

      try {
        // Phase 1: 初始化并分块上传
        await uploadWithChunks(files, password);

        // 如果是单个zip，上传完成即结束
        if (isSingleZip) {
          finishUpload();
          return;
        }

        // Phase 2: 轮询压缩状态
        await pollUploadStatus();

      } catch (error) {
        if (!uploadAborted) {
          console.error('Upload error:', error);
          showResult('上传失败: ' + error.message, 'error');
        }
        resetUpload();
      }
    });

    // R2分块上传
    async function uploadWithChunks(files, password) {
      // 步骤1: 初始化上传
      updateProgress(0, '正在初始化上传...', '', '', '');

      const filesInfo = Array.from(files).map(f => ({
        name: f.name,
        size: f.size
      }));

      const initResponse = await fetch('/api/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: filesInfo, password })
      });

      if (!initResponse.ok) {
        throw new Error('初始化失败');
      }

      const initData = await initResponse.json();
      if (!initData.success) {
        throw new Error(initData.error || '初始化失败');
      }

      uploadId = initData.uploadId;
      isSingleZip = initData.isSingleZip;
      const fileUploads = initData.files;

      // 步骤2: 分块并上传所有文件
      const totalFiles = files.length;
      let uploadedFiles = 0;
      const startTime = Date.now();
      let totalBytes = Array.from(files).reduce((sum, f) => sum + f.size, 0);
      let uploadedBytes = 0;

      for (let i = 0; i < files.length; i++) {
        if (uploadAborted) throw new Error('上传已取消');

        const file = files[i];
        const fileUpload = fileUploads[i];
        const totalChunks = fileUpload.totalChunks;

        // 🔧 修复：不再预先切片所有chunks，而是在上传时即时切片
        // 原因：预先切片会创建多个Blob引用，可能导致内存问题或文件句柄问题
        // 改为只存储chunk索引，在上传时再切片
        const chunkIndices = [];
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
          chunkIndices.push(chunkIndex);
        }

        // 并发上传分块
        let uploadedChunks = 0;
        const uploadQueue = [...chunkIndices];

        const uploadWorkers = [];
        for (let w = 0; w < MAX_CONCURRENT; w++) {
          uploadWorkers.push((async () => {
            while (uploadQueue.length > 0) {
              if (uploadAborted) return;

              const chunkIndex = uploadQueue.shift();
              if (chunkIndex === undefined) break;

              // 在上传前立即切片，避免持有多个Blob引用
              const start = chunkIndex * CHUNK_SIZE;
              const end = Math.min(start + CHUNK_SIZE, file.size);
              const chunk = file.slice(start, end);
              const chunkSize = end - start;

              const formData = new FormData();
              formData.append('uploadId', uploadId);
              formData.append('fileName', file.name);
              formData.append('chunkIndex', chunkIndex);
              formData.append('chunk', chunk);

              // 使用重试机制上传分块
              const chunkData = await retryWithBackoff(
                async () => {
                  const chunkResponse = await fetch('/api/upload/chunk', {
                    method: 'POST',
                    body: formData
                  });

                  if (!chunkResponse.ok) {
                    const error = new Error(\`分块上传失败: \${file.name} - chunk \${chunkIndex}\`);
                    error.response = chunkResponse;
                    throw error;
                  }

                  const data = await chunkResponse.json();
                  if (!data.success) {
                    const error = new Error(data.error || '分块上传失败');
                    error.response = chunkResponse;
                    throw error;
                  }

                  return data;
                },
                MAX_RETRY_ATTEMPTS,
                \`Upload chunk \${chunkIndex + 1} of \${file.name}\`
              );

              uploadedChunks++;
              uploadedBytes += chunkSize;

              // 更新进度
              const elapsed = (Date.now() - startTime) / 1000;
              const speed = uploadedBytes / elapsed;
              const remaining = (totalBytes - uploadedBytes) / speed;
              const uploadPercent = (uploadedBytes / totalBytes) * 90; // 上传占90%

              let phaseText = isSingleZip
                ? '上传中...'
                : '上传中（第1阶段，共2阶段）';

              updateProgress(
                uploadPercent,
                phaseText,
                \`文件 \${uploadedFiles + 1}/\${totalFiles}: \${file.name} (\${uploadedChunks}/\${totalChunks} 块)\`,
                formatSpeed(speed),
                '预计剩余: ' + formatTime(remaining)
              );
            }
          })());
        }

        await Promise.all(uploadWorkers);
        uploadedFiles++;
      }

      // 步骤3: 完成上传
      if (isSingleZip) {
        updateProgress(90, '完成上传...', '', '', '');
      } else {
        updateProgress(90, '上传完成，正在启动压缩...', '', '', '');
      }

      const completeResponse = await fetch('/api/upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId })
      });

      if (!completeResponse.ok) {
        throw new Error('完成上传失败');
      }

      const completeData = await completeResponse.json();
      if (!completeData.success) {
        throw new Error(completeData.error || '完成上传失败');
      }

      // 如果是单个zip，直接显示结果
      if (isSingleZip && completeData.status === 'completed') {
        updateProgress(100, '上传完成！', '', '', '');
        showSuccessResult(completeData);
      }

      // 短暂延迟让用户看到状态变化
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // 轮询上传/压缩状态
    async function pollUploadStatus() {
      updateProgress(90, '<span class="spinner">⏳</span> 压缩中（第2阶段，共2阶段）', '正在服务器端打包文件，可能需要几分钟，请耐心等待...', '', '');

      statusPollInterval = setInterval(async () => {
        if (uploadAborted) {
          clearInterval(statusPollInterval);
          return;
        }

        try {
          const response = await fetch(\`/api/upload-status/\${uploadId}\`);
          const data = await response.json();

          if (data.status === 'completed') {
            clearInterval(statusPollInterval);
            updateProgress(100, '✓ 压缩完成！', '', '', '');

            setTimeout(() => {
              showSuccessResult(data);
              finishUpload();
            }, 500);
          } else if (data.status === 'failed') {
            // 🔧 修复：直接在这里处理失败状态，而不是throw error
            // 因为在setInterval回调中throw error不会被外层catch捕获
            clearInterval(statusPollInterval);
            console.error('Compression failed:', data.error);
            showResult('压缩失败: ' + (data.error || '未知错误'), 'error');
            resetUpload();
          } else {
            // 压缩中，更新进度
            const compressPercent = 90 + (data.progress || 0) * 0.1; // 90%-100%

            let details = '';
            if (data.currentFile) {
              details = \`正在处理: \${data.currentFile}\`;
            } else if (data.processedCount !== undefined) {
              details = \`已处理 \${data.processedCount}/\${data.totalCount} 个文件\`;
            }

            updateProgress(
              compressPercent,
              '<span class="spinner">⏳</span> 压缩中（第2阶段，共2阶段）',
              details,
              '',
              '大文件压缩需要时间，请勿关闭页面'
            );
          }
        } catch (error) {
          clearInterval(statusPollInterval);
          if (!uploadAborted) {
            console.error('Status polling error:', error);
            showResult('查询状态失败: ' + error.message, 'error');
            resetUpload();
          }
        }
      }, 1000); // 每秒轮询
    }
  </script>
</body>
</html>
  `;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
}

/**
 * 渲染下载页面
 */
async function serveDownloadPage(fileId, env) {
  // 验证文件是否存在
  const metadataStr = await env.FILE_META.get(fileId);

  if (!metadataStr) {
    return new Response('文件不存在或已过期', { status: 404 });
  }

  const metadata = JSON.parse(metadataStr);

  if (isExpired(metadata.expiryTime)) {
    await deleteFile(fileId, env);
    return new Response('文件已过期', { status: 410 });
  }

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>下载文件 - FastFile</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }

    .container {
      background: white;
      border-radius: 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      padding: 40px;
      max-width: 500px;
      width: 100%;
    }

    h1 {
      text-align: center;
      color: #333;
      margin-bottom: 10px;
      font-size: 32px;
    }

    .subtitle {
      text-align: center;
      color: #666;
      margin-bottom: 30px;
      font-size: 14px;
    }

    .file-icon {
      text-align: center;
      font-size: 64px;
      margin-bottom: 20px;
    }

    .file-info {
      background: #f8f9ff;
      padding: 20px;
      border-radius: 10px;
      margin-bottom: 20px;
    }

    .file-info p {
      margin: 10px 0;
      color: #333;
      font-size: 14px;
    }

    .file-info strong {
      color: #667eea;
    }

    .password-group {
      margin-bottom: 20px;
    }

    .password-group label {
      display: block;
      margin-bottom: 8px;
      color: #333;
      font-weight: 500;
    }

    input[type="text"] {
      width: 100%;
      padding: 12px 15px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 16px;
      transition: border-color 0.3s;
    }

    input[type="text"]:focus {
      outline: none;
      border-color: #667eea;
    }

    .btn {
      width: 100%;
      padding: 12px;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      cursor: pointer;
      transition: all 0.3s;
      font-weight: 500;
      margin-bottom: 10px;
    }

    .btn-primary {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }

    .btn-primary:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 5px 20px rgba(102, 126, 234, 0.4);
    }

    .btn-primary:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .btn-success {
      background: #28a745;
      color: white;
      display: none;
    }

    .btn-success.show {
      display: block;
    }

    .btn-success:hover {
      background: #218838;
    }

    .result {
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 15px;
      display: none;
      text-align: center;
      font-size: 14px;
    }

    .result.show {
      display: block;
    }

    .result.error {
      background: #f8d7da;
      border: 2px solid #dc3545;
      color: #721c24;
    }

    .result.success {
      background: #d4edda;
      border: 2px solid #28a745;
      color: #155724;
    }

    .expiry-notice {
      text-align: center;
      color: #999;
      font-size: 13px;
      margin-top: 20px;
      padding-top: 20px;
      border-top: 1px solid #e0e0e0;
    }

    /* 移动端适配 */
    @media (max-width: 768px) {
      .container {
        padding: 30px 25px;
      }

      h1 {
        font-size: 26px;
      }

      .file-icon {
        font-size: 48px;
      }
    }

    @media (max-width: 480px) {
      body {
        padding: 15px;
      }

      .container {
        padding: 25px 20px;
      }

      h1 {
        font-size: 22px;
      }

      .btn {
        min-height: 44px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>📦 FastFile</h1>
    <p class="subtitle">文件下载</p>

    <div class="file-icon">📄</div>

    <div class="file-info">
      <p><strong>文件名称：</strong><span id="fileName">${metadata.fileName}</span></p>
      <p><strong>文件大小：</strong><span id="fileSize">${formatFileSize(metadata.fileSize)}</span></p>
      <p><strong>上传时间：</strong><span id="uploadTime">${formatDate(metadata.uploadedAt)}</span></p>
    </div>

    <div id="result" class="result"></div>

    <form id="verifyForm">
      <div class="password-group">
        <label for="password">请输入提取密码</label>
        <input type="text" id="password" placeholder="4位数字密码" maxlength="4" pattern="\\d{4}" required autofocus>
      </div>

      <button type="submit" class="btn btn-primary" id="verifyBtn">
        验证密码
      </button>
    </form>

    <button class="btn btn-success" id="downloadBtn">
      下载文件
    </button>

    <div class="expiry-notice">
      文件将在 ${formatDate(metadata.expiryTime)} 过期
    </div>
  </div>

  <script>
    const fileId = '${fileId}';
    const verifyForm = document.getElementById('verifyForm');
    const verifyBtn = document.getElementById('verifyBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const passwordInput = document.getElementById('password');
    const result = document.getElementById('result');

    let downloadUrl = '';

    // 验证密码
    verifyForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const password = passwordInput.value;

      if (!/^\\d{4}$/.test(password)) {
        showResult('密码必须是4位数字', 'error');
        return;
      }

      verifyBtn.disabled = true;
      verifyBtn.textContent = '验证中...';

      try {
        const response = await fetch('/api/verify', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ fileId, password }),
        });

        const data = await response.json();

        if (response.ok && data.success) {
          downloadUrl = data.downloadUrl;
          showResult('✓ 验证成功！可以下载文件了', 'success');
          verifyForm.style.display = 'none';
          downloadBtn.classList.add('show');
        } else {
          showResult('✗ ' + (data.error || '验证失败'), 'error');
          verifyBtn.disabled = false;
          verifyBtn.textContent = '验证密码';
        }
      } catch (error) {
        showResult('✗ 网络错误：' + error.message, 'error');
        verifyBtn.disabled = false;
        verifyBtn.textContent = '验证密码';
      }
    });

    // 下载文件
    downloadBtn.addEventListener('click', () => {
      if (downloadUrl) {
        window.location.href = downloadUrl;
      }
    });

    // 显示结果
    function showResult(message, type) {
      result.className = 'result show ' + type;
      result.textContent = message;
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// 辅助函数：格式化文件大小
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 辅助函数：格式化日期
function formatDate(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
