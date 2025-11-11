/**
 * FastFile监控集成示例
 * 展示如何在index-r2.js中集成日志和监控
 */

import { AwsClient } from 'aws4fetch';
import { zipSync } from 'fflate';
import {
  generateFileId,
  isValidPassword,
  hashPassword,
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

// 分块配置
const CHUNK_SIZE = 10 * 1024 * 1024;
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_DELAY_BASE = 1000;

export default {
  /**
   * 主入口 - 带完整监控
   */
  async fetch(request, env, ctx) {
    const requestId = generateRequestId();
    const logger = createLogger(env);
    const metrics = new MetricsTracker();
    const tracker = new RequestTracker(requestId, logger, metrics);

    try {
      const url = new URL(request.url);
      const path = url.pathname;

      tracker.event('request.start', {
        method: request.method,
        path,
        userAgent: request.headers.get('user-agent')
      });

      // CORS
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: getCorsHeaders() });
      }

      let response;

      // 路由处理
      if (path === '/api/upload/init' && request.method === 'POST') {
        response = await handleUploadInit(request, env, logger, metrics);
      } else if (path === '/api/upload/chunk' && request.method === 'POST') {
        response = await handleUploadChunk(request, env, logger, metrics);
      } else if (path === '/api/upload/complete' && request.method === 'POST') {
        response = await handleUploadComplete(request, env, ctx, logger, metrics);
      } else if (path === '/' || path === '') {
        response = serveHomePage();
      } else {
        response = errorResponse('Not found', 404);
      }

      tracker.finish(response.status, {
        contentLength: response.headers.get('content-length')
      });

      // 异步输出指标
      ctx.waitUntil((async () => {
        metrics.flush(logger);
      })());

      return response;

    } catch (error) {
      tracker.error(error, {
        path: new URL(request.url).pathname
      });
      tracker.finish(500, { error: error.message });

      logger.fatal('Request failed', {
        error,
        requestId,
        url: request.url
      });

      return errorResponse('Internal server error', 500);
    }
  }
};

/**
 * 处理上传初始化 - 带监控
 */
async function handleUploadInit(request, env, logger, metrics) {
  const requestLogger = logger.child({ handler: 'upload.init' });

  try {
    const { files, password } = await request.json();

    requestLogger.info('Upload init request', {
      filesCount: files.length,
      totalSize: files.reduce((sum, f) => sum + f.size, 0)
    });

    // 验证密码
    if (!password || !isValidPassword(password)) {
      requestLogger.warn('Invalid password provided');
      metrics.increment('upload.init.invalid_password', 1);
      return errorResponse('密码必须是4位数字');
    }

    // 验证文件
    if (!files || files.length === 0) {
      requestLogger.warn('No files provided');
      metrics.increment('upload.init.no_files', 1);
      return errorResponse('请选择要上传的文件');
    }

    const uploadId = generateFileId();
    const hashedPwd = await hashPassword(password);

    // 创建上传会话追踪器
    const uploadTracker = new UploadSessionTracker(uploadId, requestLogger, metrics);
    uploadTracker.initUpload(files.length, files.reduce((sum, f) => sum + f.size, 0));

    // 初始化aws4fetch客户端
    const awsClient = getAwsClient(env);
    const r2Url = getR2Url(env);

    // 为每个文件创建multipart upload（带重试）
    const fileUploads = [];
    for (const file of files) {
      const tempKey = `temp/${uploadId}/${file.name}`;

      try {
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
          MAX_RETRY_ATTEMPTS,
          `Create multipart upload for ${file.name}`,
          requestLogger,
          metrics
        );

        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        uploadTracker.chunks.total += totalChunks;

        fileUploads.push({
          name: file.name,
          size: file.size,
          key: tempKey,
          uploadId: xmlResult.UploadId,
          totalChunks,
          uploadedChunks: []
        });

        requestLogger.debug('File multipart upload created', {
          fileName: file.name,
          uploadId: xmlResult.UploadId,
          totalChunks
        });

      } catch (error) {
        requestLogger.error('Failed to create multipart upload', {
          fileName: file.name,
          error
        });
        metrics.increment('upload.init.file_failed', 1);
        throw error;
      }
    }

    // 保存上传元数据
    const uploadMeta = {
      uploadId,
      password: hashedPwd,
      files: fileUploads,
      totalSize: files.reduce((sum, f) => sum + f.size, 0),
      uploadedAt: Date.now(),
      status: 'uploading'
    };

    await env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(uploadMeta));

    metrics.increment('upload.init.success', 1);
    requestLogger.info('Upload initialization successful', {
      uploadId,
      filesCount: fileUploads.length
    });

    return jsonResponse({
      success: true,
      uploadId,
      files: fileUploads.map(f => ({
        name: f.name,
        totalChunks: f.totalChunks,
        uploadId: f.uploadId
      }))
    });

  } catch (error) {
    metrics.increment('upload.init.error', 1);
    requestLogger.error('Upload init failed', { error });
    return errorResponse('上传初始化失败: ' + error.message, 500);
  }
}

/**
 * 处理分块上传 - 带监控
 */
async function handleUploadChunk(request, env, logger, metrics) {
  const requestLogger = logger.child({ handler: 'upload.chunk' });
  const startTime = Date.now();

  try {
    const formData = await request.formData();
    const uploadId = formData.get('uploadId');
    const fileName = formData.get('fileName');
    const chunkIndex = parseInt(formData.get('chunkIndex'));
    const chunk = formData.get('chunk');

    requestLogger.debug('Chunk upload request', {
      uploadId,
      fileName,
      chunkIndex,
      chunkSize: chunk.size
    });

    // 获取上传元数据
    const metaStr = await env.FILE_META.get(`upload:${uploadId}`);
    if (!metaStr) {
      metrics.increment('chunk.upload.not_found', 1);
      return errorResponse('上传不存在', 404);
    }

    const meta = JSON.parse(metaStr);
    const fileUpload = meta.files.find(f => f.name === fileName);

    if (!fileUpload) {
      metrics.increment('chunk.upload.file_not_found', 1);
      return errorResponse('文件不存在', 404);
    }

    // 初始化aws4fetch客户端
    const awsClient = getAwsClient(env);
    const r2Url = getR2Url(env);

    // 使用aws4fetch上传分块（带重试和监控）
    const partNumber = chunkIndex + 1;
    const chunkBody = await chunk.arrayBuffer();

    let retryCount = 0;
    const { etag } = await retryWithBackoff(
      async (attempt) => {
        if (attempt > 1) retryCount = attempt - 1;

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
        return { etag: uploadEtag };
      },
      MAX_RETRY_ATTEMPTS,
      `Upload chunk ${partNumber} for ${fileName}`,
      requestLogger,
      metrics
    );

    // 记录已上传的分块
    fileUpload.uploadedChunks.push({
      partNumber,
      etag
    });

    // 更新元数据
    await env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(meta));

    // 计算总体进度
    const totalUploaded = meta.files.reduce((sum, f) => sum + f.uploadedChunks.length, 0);
    const totalChunks = meta.files.reduce((sum, f) => sum + f.totalChunks, 0);
    const progress = (totalUploaded / totalChunks) * 100;

    const duration = Date.now() - startTime;

    // 记录成功指标
    metrics.timing('chunk.upload.duration', duration);
    metrics.gauge('chunk.size', chunk.size);
    if (retryCount > 0) {
      metrics.increment('chunk.retried', retryCount);
    }
    metrics.increment('chunk.success', 1);

    requestLogger.info('Chunk uploaded successfully', {
      uploadId,
      fileName,
      chunkIndex,
      partNumber,
      duration,
      retryCount,
      progress: progress.toFixed(2) + '%'
    });

    return jsonResponse({
      success: true,
      uploaded: fileUpload.uploadedChunks.length,
      total: fileUpload.totalChunks,
      overallProgress: progress
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    metrics.increment('chunk.failed', 1);
    metrics.timing('chunk.upload.duration', duration, { status: 'failed' });

    requestLogger.error('Chunk upload failed', {
      error,
      duration
    });

    return errorResponse('分块上传失败: ' + error.message, 500);
  }
}

/**
 * 带监控的重试函数
 */
async function retryWithBackoff(fn, maxAttempts, operation, logger, metrics, currentAttempt = 1) {
  try {
    return await fn(currentAttempt);
  } catch (error) {
    const statusCode = error.statusCode || (error.response && error.response.status);

    if (!isRetryableError(error, statusCode)) {
      metrics.increment('retry.non_retryable', 1);
      logger.error(`${operation} failed with non-retryable error`, { error });
      throw error;
    }

    if (currentAttempt >= maxAttempts) {
      metrics.increment('retry.exhausted', 1);
      logger.error(`${operation} failed after ${maxAttempts} attempts`, { error });
      throw error;
    }

    const baseDelay = RETRY_DELAY_BASE * Math.pow(2, currentAttempt - 1);
    const jitter = Math.random() * 1000;
    const delay = baseDelay + jitter;

    metrics.increment('retry.attempt', 1, { attempt: currentAttempt });
    logger.warn(`${operation} attempt ${currentAttempt} failed, retrying...`, {
      error: error.message,
      delay,
      attempt: currentAttempt,
      maxAttempts
    });

    await new Promise(resolve => setTimeout(resolve, delay));
    return retryWithBackoff(fn, maxAttempts, operation, logger, metrics, currentAttempt + 1);
  }
}

// ... 其他辅助函数 ...

function isRetryableError(error, statusCode) {
  const retryableStatusCodes = [408, 429, 500, 502, 503, 504];
  if (statusCode && retryableStatusCodes.includes(statusCode)) {
    return true;
  }

  const errorMessage = (error.message || String(error)).toLowerCase();
  const retryableErrorPatterns = [
    'network', 'timeout', 'econnreset', 'etimedout',
    'connection lost', 'connection closed', 'socket hang up',
    'enotfound', 'econnrefused', 'fetch failed', 'failed to fetch',
    'network request failed', 'aborted', 'request aborted',
  ];

  for (const pattern of retryableErrorPatterns) {
    if (errorMessage.includes(pattern)) {
      return true;
    }
  }

  return false;
}

function getAwsClient(env) {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  });
}

function getR2Url(env) {
  const accountId = env.R2_ACCOUNT_ID;
  const bucketName = env.R2_BUCKET_NAME || 'fastfile-storage';
  return `https://${accountId}.r2.cloudflarestorage.com/${bucketName}`;
}

async function parseXmlResponse(response) {
  const text = await response.text();
  const result = {};

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

function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function serveHomePage() {
  return new Response('<h1>FastFile API</h1>', {
    headers: { 'Content-Type': 'text/html' }
  });
}
