/**
 * FastFile - Cloudflare Workers 主入口
 * R2 Multipart Upload 优化版本 (使用aws4fetch)
 * 带监控和日志支持
 */

import { AwsClient } from 'aws4fetch';
import { zipSync } from 'fflate';
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

// 分块配置
const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB per chunk (R2最小5MB)
const MAX_RETRY_ATTEMPTS = 5; // 最大重试次数（增加到5次）
const RETRY_DELAY_BASE = 1000; // 基础重试延迟(ms)

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
async function retryWithBackoff(fn, maxAttempts = MAX_RETRY_ATTEMPTS, operation = 'operation') {
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
      const baseDelay = RETRY_DELAY_BASE * Math.pow(2, attempt - 1);
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
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // 路由处理
    try {
      // API路由
      if (path.startsWith('/api/')) {
        // R2 Multipart Upload 路由
        if (path === '/api/upload/init' && request.method === 'POST') {
          return await handleUploadInit(request, env);
        }

        if (path === '/api/upload/chunk' && request.method === 'POST') {
          return await handleUploadChunk(request, env);
        }

        if (path === '/api/upload/complete' && request.method === 'POST') {
          return await handleUploadComplete(request, env, ctx);
        }

        if (path === '/api/verify' && request.method === 'POST') {
          return await handleVerify(request, env);
        }

        if (path.startsWith('/api/download/')) {
          const fileId = path.split('/')[3];
          return await handleDownload(fileId, request, env);
        }

        if (path.startsWith('/api/upload-status/')) {
          const uploadId = path.split('/')[3];
          return await handleUploadStatus(uploadId, env);
        }

        return errorResponse('API端点不存在', 404);
      }

      // 下载页面路由
      if (path.startsWith('/d/')) {
        const fileId = path.split('/')[2];
        return await serveDownloadPage(fileId, env);
      }

      // 默认返回上传页面
      if (path === '/' || path === '/index.html') {
        return await serveUploadPage();
      }

      return errorResponse('页面不存在', 404);
    } catch (error) {
      console.error('Error:', error);
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
async function handleUploadInit(request, env) {
  try {
    const { files, password } = await request.json();

    // 验证密码
    if (!password || !isValidPassword(password)) {
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
        MAX_RETRY_ATTEMPTS,
        `Create multipart upload for ${file.name}`
      );

      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

      fileUploads.push({
        name: file.name,
        size: file.size,
        key: tempKey,
        uploadId: xmlResult.UploadId,
        totalChunks,
        uploadedChunks: []
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
      chunkSize: CHUNK_SIZE
    });

  } catch (error) {
    console.error('Init error:', error);
    return errorResponse('初始化失败: ' + error.message, 500);
  }
}

/**
 * 上传单个分块
 */
async function handleUploadChunk(request, env) {
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
      MAX_RETRY_ATTEMPTS,
      `Upload chunk ${partNumber} for ${fileName}`
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

    return jsonResponse({
      success: true,
      uploaded: fileUpload.uploadedChunks.length,
      total: fileUpload.totalChunks,
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
async function handleUploadComplete(request, env, ctx) {
  try {
    const { uploadId } = await request.json();

    // 获取上传元数据
    const metaStr = await env.FILE_META.get(`upload:${uploadId}`);
    if (!metaStr) {
      return errorResponse('上传不存在', 404);
    }

    const meta = JSON.parse(metaStr);

    // 验证所有文件的所有分块都已上传
    for (const fileUpload of meta.files) {
      if (fileUpload.uploadedChunks.length !== fileUpload.totalChunks) {
        return errorResponse(`文件 ${fileUpload.name} 未完全上传`);
      }
    }

    // 初始化aws4fetch客户端
    const awsClient = getAwsClient(env);
    const r2Url = getR2Url(env);

    // 完成所有文件的multipart upload
    for (const fileUpload of meta.files) {
      // 按partNumber排序
      const sortedParts = fileUpload.uploadedChunks.sort((a, b) => a.partNumber - b.partNumber);

      // 构建XML body
      const partsXml = sortedParts
        .map(part => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag}</ETag></Part>`)
        .join('');
      const xmlBody = `<CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`;

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
            const error = new Error(`完成multipart upload失败: ${errorText}`);
            error.statusCode = completeResponse.status;
            throw error;
          }

          return completeResponse;
        },
        MAX_RETRY_ATTEMPTS,
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
    ctx.waitUntil(performCompression(uploadId, meta, env));

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
 * 执行实际的压缩操作（从R2读取文件）
 */
async function performCompression(uploadId, uploadMeta, env) {
  try {
    uploadMeta.status = 'compressing';
    await env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(uploadMeta));

    // 准备压缩数据
    const filesToZip = {};
    let processedCount = 0;

    // 从R2读取所有已上传的文件
    for (const fileInfo of uploadMeta.files) {
      const obj = await env.FILE_STORAGE.get(fileInfo.key);
      if (!obj) {
        throw new Error(`文件不存在: ${fileInfo.name}`);
      }

      const fileData = await obj.arrayBuffer();
      filesToZip[fileInfo.name] = new Uint8Array(fileData);

      processedCount++;

      // 更新进度
      const progress = Math.round((processedCount / uploadMeta.files.length) * 50); // 0-50% for reading
      compressionProgress.set(uploadId, {
        status: 'reading',
        progress,
        currentFile: fileInfo.name,
        processedCount,
        totalCount: uploadMeta.files.length,
      });
    }

    // 更新进度：开始压缩
    compressionProgress.set(uploadId, {
      status: 'compressing',
      progress: 50,
      message: '开始压缩文件...',
    });

    // 使用fflate进行同步压缩
    const zipped = zipSync(filesToZip, {
      level: 3, // 压缩级别 0-9，使用3提供快速压缩和适中的压缩率
    });

    // 更新进度：压缩完成，保存文件
    compressionProgress.set(uploadId, {
      status: 'saving',
      progress: 90,
      message: '正在保存压缩文件...',
    });

    // 生成最终文件ID
    const fileId = generateFileId();
    const expiryTime = getExpiryTime();

    // 存储压缩后的文件到R2
    await env.FILE_STORAGE.put(fileId, zipped);

    // 保存最终元数据
    const metadata = {
      fileId,
      password: uploadMeta.password,
      expiryTime,
      createdAt: Date.now(),
      fileName: 'files.zip',
      fileSize: zipped.byteLength,
      originalFileCount: uploadMeta.files.length,
      originalTotalSize: uploadMeta.totalSize,
    };

    await env.FILE_META.put(fileId, JSON.stringify(metadata));

    // 删除临时文件
    for (const fileInfo of uploadMeta.files) {
      await env.FILE_STORAGE.delete(fileInfo.key);
    }

    // 更新上传元数据为已完成
    uploadMeta.status = 'completed';
    uploadMeta.fileId = fileId;
    uploadMeta.compressedAt = Date.now();
    uploadMeta.compressedSize = zipped.byteLength;
    await env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(uploadMeta));

    // 更新最终进度
    compressionProgress.set(uploadId, {
      status: 'completed',
      progress: 100,
      fileId,
      downloadUrl: `/d/${fileId}`,
    });

    // 5分钟后清理进度数据
    setTimeout(() => {
      compressionProgress.delete(uploadId);
    }, 5 * 60 * 1000);

  } catch (error) {
    console.error('Compression error:', error);

    // 更新状态为失败
    uploadMeta.status = 'failed';
    uploadMeta.error = error.message;
    await env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(uploadMeta));

    compressionProgress.set(uploadId, {
      status: 'failed',
      error: error.message,
    });
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

    // 从R2获取文件
    const object = await env.FILE_STORAGE.get(fileId);

    if (!object) {
      return errorResponse('文件数据不存在', 404);
    }

    // 返回文件
    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(metadata.fileName)}"`,
        'Content-Length': metadata.fileSize.toString(),
        'Access-Control-Allow-Origin': '*',
      },
    });

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
      transition: border-color 0.3s;
    }

    input[type="text"]:focus {
      outline: none;
      border-color: #667eea;
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
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-weight: bold;
      font-size: 14px;
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
      animation: spinner-rotate 1s linear infinite;
    }

    @keyframes spinner-rotate {
      0% { opacity: 0.3; }
      50% { opacity: 1; }
      100% { opacity: 0.3; }
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

    // R2分块配置
    const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB
    const MAX_CONCURRENT = 4; // 最大并发上传数（从8降到4，提高稳定性）
    const MAX_RETRY_ATTEMPTS = 5; // 最大重试次数（增加到5次）
    const RETRY_DELAY_BASE = 1000; // 基础重试延迟(ms)

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
      progressBar.textContent = Math.round(percent) + '%';
      progressPhase.textContent = phase;
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
      regenerateBtn.style.display = '';
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
      showResult(\`
        <strong>上传成功！</strong><br>
        文件ID: \${data.fileId}<br>
        <a href="\${downloadUrl}" class="download-link" target="_blank">前往下载页面</a>
      \`, 'success');
    }

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

      // 开始上传
      isUploading = true;
      uploadAborted = false;
      uploadBtn.style.display = 'none';
      progressContainer.classList.add('show');
      warningBanner.classList.add('show');
      cancelBtn.classList.add('show');
      result.classList.remove('show');

      // 隐藏上传区域、已选文件列表和重新生成按钮
      uploadArea.style.display = 'none';
      selectedFiles.style.display = 'none';
      regenerateBtn.style.display = 'none';

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

        // 分块上传当前文件
        const chunks = [];
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
          const start = chunkIndex * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, file.size);
          const chunk = file.slice(start, end);
          chunks.push({ chunkIndex, chunk, size: end - start });
        }

        // 并发上传分块
        let uploadedChunks = 0;
        const uploadQueue = [...chunks];

        const uploadWorkers = [];
        for (let w = 0; w < MAX_CONCURRENT; w++) {
          uploadWorkers.push((async () => {
            while (uploadQueue.length > 0) {
              if (uploadAborted) return;

              const chunkInfo = uploadQueue.shift();
              if (!chunkInfo) break;

              const formData = new FormData();
              formData.append('uploadId', uploadId);
              formData.append('fileName', file.name);
              formData.append('chunkIndex', chunkInfo.chunkIndex);
              formData.append('chunk', chunkInfo.chunk);

              // 使用重试机制上传分块
              const chunkData = await retryWithBackoff(
                async () => {
                  const chunkResponse = await fetch('/api/upload/chunk', {
                    method: 'POST',
                    body: formData
                  });

                  if (!chunkResponse.ok) {
                    const error = new Error(\`分块上传失败: \${file.name} - chunk \${chunkInfo.chunkIndex}\`);
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
                \`Upload chunk \${chunkInfo.chunkIndex + 1} of \${file.name}\`
              );

              uploadedChunks++;
              uploadedBytes += chunkInfo.size;

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
      updateProgress(90, '🔄 压缩中（第2阶段，共2阶段）', '正在服务器端打包文件，可能需要几分钟，请耐心等待...', '', '');

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
            updateProgress(100, '压缩完成！', '', '', '');

            setTimeout(() => {
              showSuccessResult(data);
              finishUpload();
            }, 500);
          } else if (data.status === 'failed') {
            clearInterval(statusPollInterval);
            throw new Error(data.error || '压缩失败');
          } else {
            // 压缩中，更新进度
            const compressPercent = 90 + (data.progress || 0) * 0.1; // 90%-100%

            // 动态转圈符号
            const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
            const spinnerIndex = Math.floor(Date.now() / 100) % spinnerFrames.length;
            const spinner = spinnerFrames[spinnerIndex];

            let details = '';
            if (data.currentFile) {
              details = \`正在处理: \${data.currentFile}\`;
            } else if (data.processedCount !== undefined) {
              details = \`已处理 \${data.processedCount}/\${data.totalCount} 个文件\`;
            }

            updateProgress(
              compressPercent,
              \`\${spinner} 压缩中（第2阶段，共2阶段）\`,
              details,
              '',
              '大文件压缩需要时间，请勿关闭页面'
            );
          }
        } catch (error) {
          clearInterval(statusPollInterval);
          if (!uploadAborted) {
            throw error;
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
      <p><strong>上传时间：</strong><span id="uploadTime">${formatDate(metadata.createdAt)}</span></p>
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
