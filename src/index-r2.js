/**
 * FastFile - Cloudflare Workers 主入口
 * R2 Multipart Upload 优化版本 (使用aws4fetch)
 * 带监控和日志支持
 */

import { AwsClient } from 'aws4fetch';
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
import {
  handleUploadInit,
  handleUploadChunk,
  handleUploadChunkConfirm,
  handleUploadComplete,
  handleUploadStatus,
  handleVerify,
  handleDownload,
  cleanupExpiredFiles,
  performCompression
} from './handlers.js';
import {
  serveUploadPage,
  serveDownloadPage
} from './templates.js';

// =============================================
// 统一配置 - 前后端共享
// =============================================
const CONFIG = {
  CHUNK_SIZE: 5 * 1024 * 1024, // 5MB - R2 Multipart 要求（除最后一个part外必须≥5MB）
  MAX_CONCURRENT: 3, // 最大并发上传数 - 降低以避免带宽分散
  MAX_RETRY_ATTEMPTS: 5, // 最大重试次数
  RETRY_DELAY_BASE: 1000, // 基础重试延迟(ms)
  REQUEST_TIMEOUT: 180000, // 单个chunk上传超时(ms) - 180秒，适配生产环境慢速网络
  INIT_TIMEOUT: 30000, // 初始化请求超时(ms) - 30秒
  STATUS_TIMEOUT: 15000, // 状态查询超时(ms) - 15秒
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
    599, // Network Timeout (非标准，但某些代理使用)
  ];

  if (statusCode && retryableStatusCodes.includes(statusCode)) {
    return true;
  }

  // 网络错误（扩展）
  const errorMessage = (error.message || String(error)).toLowerCase();
  const retryableErrorPatterns = [
    'network',
    'timeout',
    'timed out',
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
    'protocol error',  // 添加对HTTP/2协议错误的识别
    'err_http2',       // 添加对ERR_HTTP2错误的识别
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
          const response = await handleUploadInit(request, env, logger, metrics, CONFIG, retryWithBackoff, getAwsClient, getR2Url, parseXmlResponse);
          tracker.finish(response.status, { handler: 'upload.init' });
          ctx.waitUntil(metrics.flush(logger));
          return response;
        }

        if (path === '/api/upload/chunk' && request.method === 'POST') {
          const response = await handleUploadChunk(request, env, logger, metrics, CONFIG, retryWithBackoff, getAwsClient, getR2Url);
          tracker.finish(response.status, { handler: 'upload.chunk' });
          ctx.waitUntil(metrics.flush(logger));
          return response;
        }

        if (path === '/api/upload/chunk/confirm' && request.method === 'POST') {
          const response = await handleUploadChunkConfirm(request, env, logger, metrics);
          tracker.finish(response.status, { handler: 'upload.chunk.confirm' });
          ctx.waitUntil(metrics.flush(logger));
          return response;
        }

        if (path === '/api/upload/complete' && request.method === 'POST') {
          const response = await handleUploadComplete(request, env, ctx, logger, metrics, CONFIG, retryWithBackoff, getAwsClient, getR2Url, performCompression);
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

        // 验证文件是否存在
        const metadataStr = await env.FILE_META.get(fileId);

        if (!metadataStr) {
          tracker.finish(404, { handler: 'download-page', fileId, error: 'not_found' });
          ctx.waitUntil(metrics.flush(logger));
          return new Response('文件不存在或已过期', {
            status: 404,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }

        const metadata = JSON.parse(metadataStr);

        // 检查文件是否过期
        if (isExpired(metadata.expiryTime)) {
          // 删除过期文件
          try {
            await env.FILE_STORAGE.delete(fileId);
            await env.FILE_META.delete(fileId);
          } catch (error) {
            console.error('Delete expired file error:', error);
          }

          tracker.finish(410, { handler: 'download-page', fileId, error: 'expired' });
          ctx.waitUntil(metrics.flush(logger));
          return new Response('文件已过期', {
            status: 410,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }

        // 生成下载页面
        const response = await serveDownloadPage(fileId, metadata);
        tracker.finish(response.status, { handler: 'download-page', fileId });
        ctx.waitUntil(metrics.flush(logger));
        return response;
      }

      // 默认返回上传页面
      if (path === '/' || path === '/index.html') {
        const response = await serveUploadPage(CONFIG);
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
