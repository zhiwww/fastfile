/**
 * FastFile - Cloudflare Workers 主入口
 * 大文件中转应用 - 服务器端压缩版本
 */

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

// 用于存储压缩进度的临时状态
const compressionProgress = new Map();

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
        if (path === '/api/upload-multi' && request.method === 'POST') {
          return await handleMultiUpload(request, env);
        }

        if (path === '/api/compress' && request.method === 'POST') {
          return await handleCompress(request, env, ctx);
        }

        if (path.startsWith('/api/compress-status/')) {
          const uploadId = path.split('/')[3];
          return await handleCompressStatus(uploadId, env);
        }

        if (path === '/api/verify' && request.method === 'POST') {
          return await handleVerify(request, env);
        }

        if (path.startsWith('/api/download/')) {
          const fileId = path.split('/')[3];
          return await handleDownload(fileId, request, env);
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
 * 处理多文件上传（Phase 1）
 */
async function handleMultiUpload(request, env) {
  try {
    const formData = await request.formData();
    const password = formData.get('password');

    // 验证密码
    if (!password || !isValidPassword(password)) {
      return errorResponse('密码必须是4位数字');
    }

    // 获取所有文件
    const files = formData.getAll('files');
    if (!files || files.length === 0) {
      return errorResponse('请选择要上传的文件');
    }

    // 生成上传ID
    const uploadId = generateFileId();
    const hashedPwd = await hashPassword(password);

    // 检查是否为单个zip文件（跳过压缩）
    const isSingleZip = files.length === 1 && files[0].name.toLowerCase().endsWith('.zip');

    if (isSingleZip) {
      // 单个zip文件，直接存储，不需要压缩
      const file = files[0];
      const fileBuffer = await file.arrayBuffer();
      const fileSize = fileBuffer.byteLength;

      // 检查文件大小
      if (fileSize > 10 * 1024 * 1024 * 1024) {
        return errorResponse('文件大小超过10GB限制');
      }

      const fileId = generateFileId();
      const expiryTime = getExpiryTime();

      // 直接存储文件
      await env.FILE_STORAGE.put(fileId, fileBuffer);

      // 保存元数据
      const metadata = {
        fileId,
        password: hashedPwd,
        expiryTime,
        createdAt: Date.now(),
        fileName: file.name,
        fileSize,
      };

      await env.FILE_META.put(fileId, JSON.stringify(metadata));

      return jsonResponse({
        success: true,
        uploadId,
        fileId,
        isSingleZip: true,
        downloadUrl: `/d/${fileId}`,
        expiryTime,
      });
    }

    // 多文件或非zip文件，需要压缩
    // 存储上传的文件到临时位置
    const uploadedFiles = [];
    let totalSize = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileBuffer = await file.arrayBuffer();
      const fileSize = fileBuffer.byteLength;
      totalSize += fileSize;

      // 使用临时前缀存储
      const tempKey = `temp/${uploadId}/${file.name}`;
      await env.FILE_STORAGE.put(tempKey, fileBuffer);

      uploadedFiles.push({
        name: file.name,
        size: fileSize,
        key: tempKey,
      });
    }

    // 检查总大小
    if (totalSize > 10 * 1024 * 1024 * 1024) {
      // 清理临时文件
      for (const f of uploadedFiles) {
        await env.FILE_STORAGE.delete(f.key);
      }
      return errorResponse('文件总大小超过10GB限制');
    }

    // 保存上传元数据
    const uploadMeta = {
      uploadId,
      password: hashedPwd,
      files: uploadedFiles,
      totalSize,
      uploadedAt: Date.now(),
      status: 'uploaded', // uploaded, compressing, completed, failed
    };

    await env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(uploadMeta));

    return jsonResponse({
      success: true,
      uploadId,
      fileCount: files.length,
      totalSize,
      isSingleZip: false,
    });

  } catch (error) {
    console.error('Upload error:', error);
    return errorResponse('上传失败: ' + error.message, 500);
  }
}

/**
 * 处理压缩请求（Phase 2）
 */
async function handleCompress(request, env, ctx) {
  try {
    const { uploadId } = await request.json();

    if (!uploadId) {
      return errorResponse('缺少上传ID');
    }

    // 获取上传元数据
    const uploadMetaStr = await env.FILE_META.get(`upload:${uploadId}`);
    if (!uploadMetaStr) {
      return errorResponse('上传不存在', 404);
    }

    const uploadMeta = JSON.parse(uploadMetaStr);

    // 检查状态
    if (uploadMeta.status === 'compressing') {
      return jsonResponse({
        success: true,
        status: 'compressing',
        message: '正在压缩中',
      });
    }

    if (uploadMeta.status === 'completed') {
      return jsonResponse({
        success: true,
        status: 'completed',
        fileId: uploadMeta.fileId,
        downloadUrl: `/d/${uploadMeta.fileId}`,
      });
    }

    // 更新状态为压缩中
    uploadMeta.status = 'compressing';
    uploadMeta.compressStartedAt = Date.now();
    await env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(uploadMeta));

    // 使用waitUntil来执行压缩任务（不阻塞响应）
    ctx.waitUntil(performCompression(uploadId, uploadMeta, env));

    return jsonResponse({
      success: true,
      status: 'compressing',
      message: '压缩已开始',
    });

  } catch (error) {
    console.error('Compress error:', error);
    return errorResponse('压缩失败: ' + error.message, 500);
  }
}

/**
 * 执行实际的压缩操作
 */
async function performCompression(uploadId, uploadMeta, env) {
  try {
    // 准备压缩数据
    const filesToZip = {};
    let processedCount = 0;

    // 从R2读取所有文件
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

    // 更新进度：压缩完成
    compressionProgress.set(uploadId, {
      status: 'compressing',
      progress: 90,
      message: '正在保存压缩文件...',
    });

    // 生成最终文件ID
    const fileId = generateFileId();
    const expiryTime = getExpiryTime();

    // 存储压缩后的文件
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

    // 更新上传元数据为已完成
    uploadMeta.status = 'completed';
    uploadMeta.fileId = fileId;
    uploadMeta.compressedAt = Date.now();
    uploadMeta.compressedSize = zipped.byteLength;
    await env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(uploadMeta));

    // 删除临时文件
    for (const fileInfo of uploadMeta.files) {
      await env.FILE_STORAGE.delete(fileInfo.key);
    }

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
 * 查询压缩状态
 */
async function handleCompressStatus(uploadId, env) {
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
        compressedSize: uploadMeta.compressedSize,
      });
    }

    if (uploadMeta.status === 'failed') {
      return jsonResponse({
        success: false,
        status: 'failed',
        error: uploadMeta.error || '压缩失败',
      });
    }

    // 其他状态
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
 * 渲染上传页面
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

    .btn {
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

    .btn-primary:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 5px 20px rgba(102, 126, 234, 0.4);
    }

    .btn-primary:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .btn-secondary {
      background: white;
      color: #667eea;
      border: 2px solid #667eea;
    }

    .btn-secondary:hover {
      background: #667eea;
      color: white;
    }

    .btn-cancel {
      background: #ff4757;
      color: white;
      width: 100%;
      margin-top: 10px;
      display: none;
    }

    .btn-cancel.show {
      display: block;
    }

    .btn-cancel:hover {
      background: #ff3838;
    }

    .progress-container {
      margin: 20px 0;
      display: none;
    }

    .progress-container.show {
      display: block;
    }

    .progress-bar-bg {
      width: 100%;
      height: 30px;
      background: #e0e0e0;
      border-radius: 15px;
      overflow: hidden;
      position: relative;
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
      margin-top: 15px;
      padding: 15px;
      background: #f8f9ff;
      border-radius: 8px;
    }

    .progress-phase {
      font-weight: 600;
      color: #667eea;
      margin-bottom: 8px;
      font-size: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .progress-phase .spinner {
      display: inline-block;
      animation: spinner-rotate 1s linear infinite;
    }

    @keyframes spinner-rotate {
      0% { opacity: 0.3; }
      50% { opacity: 1; }
      100% { opacity: 0.3; }
    }

    .progress-details {
      display: flex;
      justify-content: space-between;
      color: #666;
      font-size: 14px;
      margin-bottom: 5px;
    }

    .progress-time {
      color: #999;
      font-size: 13px;
    }

    .warning-banner {
      background: #fff3cd;
      border: 2px solid #ffc107;
      color: #856404;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 15px;
      display: none;
      text-align: center;
      font-weight: 500;
    }

    .warning-banner.show {
      display: block;
    }

    .result {
      margin-top: 20px;
      padding: 20px;
      border-radius: 8px;
      display: none;
    }

    .result.show {
      display: block;
    }

    .result.success {
      background: #d4edda;
      border: 2px solid #28a745;
      color: #155724;
    }

    .result.error {
      background: #f8d7da;
      border: 2px solid #dc3545;
      color: #721c24;
    }

    .result h3 {
      margin-bottom: 15px;
      font-size: 18px;
    }

    .result-info {
      background: white;
      padding: 15px;
      border-radius: 5px;
      margin-bottom: 10px;
    }

    .result-info p {
      margin: 8px 0;
      font-size: 14px;
    }

    .download-link {
      word-break: break-all;
      color: #667eea;
      text-decoration: none;
      font-weight: 500;
    }

    .download-link:hover {
      text-decoration: underline;
    }

    .notice {
      margin-top: 10px;
      padding: 10px;
      background: #fff3cd;
      border-radius: 5px;
      font-size: 13px;
      color: #856404;
    }

    .features {
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #e0e0e0;
    }

    .feature-list {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
      margin-top: 15px;
    }

    .feature-item {
      display: flex;
      align-items: center;
      font-size: 14px;
      color: #666;
    }

    .feature-item::before {
      content: "✓";
      color: #28a745;
      font-weight: bold;
      margin-right: 8px;
      font-size: 16px;
    }

    /* 移动端适配 */
    @media (max-width: 768px) {
      .container {
        padding: 25px;
      }

      h1 {
        font-size: 26px;
      }

      .upload-area {
        padding: 30px 20px;
      }

      .upload-icon {
        font-size: 36px;
      }

      .feature-list {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 480px) {
      body {
        padding: 15px;
      }

      .container {
        padding: 20px;
      }

      h1 {
        font-size: 22px;
      }

      .password-input-group {
        flex-direction: column;
      }

      .btn {
        min-height: 44px;
      }
    }

    @media (max-width: 360px) {
      .container {
        padding: 15px;
      }

      h1 {
        font-size: 20px;
      }

      .upload-area {
        padding: 20px 15px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>📦 FastFile</h1>
    <p class="subtitle">大文件中转 • 简单快速安全</p>

    <form id="uploadForm">
      <div class="upload-area" id="uploadArea">
        <div class="upload-icon">📁</div>
        <p style="margin-bottom: 10px; font-size: 16px; color: #333;">点击选择文件或拖拽文件到这里</p>
        <p style="font-size: 13px; color: #999;">支持多文件上传，最大10GB</p>
        <input type="file" id="fileInput" class="file-input" multiple>
      </div>

      <div class="selected-files" id="selectedFiles">
        <strong>已选择文件：</strong>
        <div class="file-list" id="fileList"></div>
      </div>

      <div class="password-group">
        <label for="password">设置提取密码（4位数字）</label>
        <div class="password-input-group">
          <input type="text" id="password" placeholder="自动生成的密码" maxlength="4" pattern="\\d{4}" required>
          <button type="button" class="btn btn-secondary" id="regenerateBtn">重新生成</button>
        </div>
      </div>

      <div class="warning-banner" id="warningBanner">
        ⚠️ 上传未完成，离开网页会丢失所有已上传内容！
      </div>

      <div class="progress-container" id="progressContainer">
        <div class="progress-bar-bg">
          <div class="progress-bar" id="progressBar">0%</div>
        </div>
        <div class="progress-info">
          <div class="progress-phase" id="progressPhase">准备上传...</div>
          <div class="progress-details">
            <span id="progressDetails"></span>
            <span id="progressSpeed"></span>
          </div>
          <div class="progress-time" id="progressTime"></div>
        </div>
      </div>

      <button type="submit" class="btn btn-primary" id="uploadBtn">
        上传文件
      </button>

      <button type="button" class="btn btn-cancel" id="cancelBtn">
        取消上传
      </button>
    </form>

    <div class="result" id="result"></div>

    <div class="features">
      <strong style="color: #333;">特性：</strong>
      <div class="feature-list">
        <div class="feature-item">无需注册</div>
        <div class="feature-item">最大10GB</div>
        <div class="feature-item">密码保护</div>
        <div class="feature-item">30天有效</div>
      </div>
    </div>
  </div>

  <script>
    // DOM元素
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    const selectedFiles = document.getElementById('selectedFiles');
    const fileList = document.getElementById('fileList');
    const passwordInput = document.getElementById('password');
    const regenerateBtn = document.getElementById('regenerateBtn');
    const uploadForm = document.getElementById('uploadForm');
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

    let uploadXHR = null;
    let isUploading = false;
    let uploadStartTime = 0;
    let uploadId = null;
    let compressionPollInterval = null;
    let isSingleZip = false;

    // 生成随机4位数字密码
    function generatePassword() {
      return Math.floor(1000 + Math.random() * 9000).toString();
    }

    // 初始化：设置随机密码
    passwordInput.value = generatePassword();

    // 重新生成密码
    regenerateBtn.addEventListener('click', () => {
      passwordInput.value = generatePassword();
      passwordInput.select();
    });

    // 点击密码框时自动选中
    passwordInput.addEventListener('click', () => {
      passwordInput.select();
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
      progressSpeed.textContent = speed;
      progressTime.textContent = time;
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
      uploadStartTime = Date.now();
      uploadBtn.style.display = 'none';  // 隐藏上传按钮
      progressContainer.classList.add('show');
      warningBanner.classList.add('show');
      cancelBtn.classList.add('show');
      result.classList.remove('show');

      // 隐藏上传区域、已选文件列表和重新生成按钮
      uploadArea.style.display = 'none';
      selectedFiles.style.display = 'none';
      regenerateBtn.style.display = 'none';

      // 如果是单个zip文件，不显示压缩相关提示
      if (isSingleZip) {
        updateProgress(0, '上传中...', '', '', '');
      } else {
        updateProgress(0, '上传中（第1阶段）', '', '', '');
      }

      try {
        // Phase 1: 上传文件
        await uploadFiles(files, password);

        // 如果是单个zip，不需要压缩阶段
        if (isSingleZip) {
          // 上传完成即结束
          finishUpload();
          return;
        }

        // Phase 2: 服务器端压缩
        await compressFiles();

      } catch (error) {
        console.error('Upload error:', error);
        showResult('上传失败: ' + error.message, 'error');
        resetUpload();
      }
    });

    // 上传文件（Phase 1）
    function uploadFiles(files, password) {
      return new Promise((resolve, reject) => {
        const formData = new FormData();

        // 添加所有文件
        Array.from(files).forEach(file => {
          formData.append('files', file);
        });

        formData.append('password', password);

        uploadXHR = new XMLHttpRequest();

        let lastLoaded = 0;
        let lastTime = Date.now();

        // 上传进度
        uploadXHR.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const now = Date.now();
            const timeDiff = (now - lastTime) / 1000;
            const loadedDiff = e.loaded - lastLoaded;

            if (timeDiff >= 0.1) {
              const speed = loadedDiff / timeDiff;
              const remaining = (e.total - e.loaded) / speed;
              const uploadPercent = (e.loaded / e.total) * 90; // 上传占90%

              let phaseText = isSingleZip ? '上传中...' : '上传中（第1阶段，共2阶段）';

              updateProgress(
                uploadPercent,
                phaseText,
                \`\${formatFileSize(e.loaded)} / \${formatFileSize(e.total)}\`,
                formatSpeed(speed),
                '预计剩余: ' + formatTime(remaining)
              );

              lastLoaded = e.loaded;
              lastTime = now;
            }
          }
        });

        // 上传完成
        uploadXHR.addEventListener('load', () => {
          if (uploadXHR.status === 200) {
            const response = JSON.parse(uploadXHR.responseText);
            if (response.success) {
              uploadId = response.uploadId;
              isSingleZip = response.isSingleZip;

              if (isSingleZip) {
                // 单个zip文件，直接完成
                updateProgress(100, '上传完成！', '', '', '');
                showSuccessResult(response);
                resolve();
              } else {
                // 需要压缩 - 立即显示压缩状态
                updateProgress(90, '上传完成，正在启动压缩...', '', '', '');
                // 短暂延迟后开始压缩，让用户看到状态变化
                setTimeout(() => resolve(), 100);
              }
            } else {
              reject(new Error(response.error || '上传失败'));
            }
          } else {
            reject(new Error('上传失败，状态码: ' + uploadXHR.status));
          }
        });

        // 错误处理
        uploadXHR.addEventListener('error', () => {
          reject(new Error('网络错误'));
        });

        uploadXHR.addEventListener('abort', () => {
          reject(new Error('上传已取消'));
        });

        uploadXHR.open('POST', '/api/upload-multi');
        uploadXHR.send(formData);
      });
    }

    // 开始压缩（Phase 2）
    async function compressFiles() {
      try {
        // 请求开始压缩
        const response = await fetch('/api/compress', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ uploadId }),
        });

        const data = await response.json();

        if (!data.success) {
          throw new Error(data.error || '压缩请求失败');
        }

        // 开始轮询压缩状态
        updateProgress(90, '🔄 压缩中（第2阶段，共2阶段）', '正在服务器端打包文件，可能需要几分钟，请耐心等待...', '', '');

        compressionPollInterval = setInterval(async () => {
          await pollCompressionStatus();
        }, 1000); // 每秒轮询一次

      } catch (error) {
        throw error;
      }
    }

    // 轮询压缩状态
    async function pollCompressionStatus() {
      try {
        const response = await fetch(\`/api/compress-status/\${uploadId}\`);
        const data = await response.json();

        if (data.status === 'completed') {
          clearInterval(compressionPollInterval);
          updateProgress(100, '压缩完成！', '', '', '');

          setTimeout(() => {
            showSuccessResult({
              fileId: data.fileId,
              downloadUrl: data.downloadUrl,
              compressedSize: data.compressedSize,
            });
            finishUpload();
          }, 500);
        } else if (data.status === 'failed') {
          clearInterval(compressionPollInterval);
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
          } else if (data.message) {
            details = data.message;
          } else {
            details = '文件压缩中，可能需要几分钟，请耐心等待...';
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
        clearInterval(compressionPollInterval);
        throw error;
      }
    }

    // 显示成功结果
    function showSuccessResult(data) {
      const fullUrl = window.location.origin + data.downloadUrl;
      const password = passwordInput.value;

      const resultHtml = \`
        <h3>✅ 上传成功！</h3>
        <div class="result-info">
          <p><strong>下载链接：</strong></p>
          <p><a href="\${data.downloadUrl}" class="download-link" target="_blank">\${fullUrl}</a></p>
          <p><strong>提取密码：</strong> <span style="font-size: 18px; font-weight: bold; color: #dc3545;">\${password}</span></p>
          \${data.compressedSize ? \`<p><strong>文件大小：</strong> \${formatFileSize(data.compressedSize)}</p>\` : ''}
        </div>
        <div class="notice">
          <strong>⚠️ 重要提示：</strong><br>
          1. 请务必保存下载链接和提取密码<br>
          2. 文件将在30天后自动删除<br>
          3. 请勿上传违法违规内容
        </div>
      \`;

      showResult(resultHtml, 'success');
    }

    // 完成上传
    function finishUpload() {
      isUploading = false;
      uploadBtn.style.display = '';  // 恢复显示上传按钮
      warningBanner.classList.remove('show');
      cancelBtn.classList.remove('show');

      // 恢复显示上传区域、已选文件列表和重新生成按钮
      uploadArea.style.display = '';
      selectedFiles.style.display = '';
      regenerateBtn.style.display = '';
    }

    // 重置上传状态
    function resetUpload() {
      isUploading = false;
      uploadBtn.style.display = '';  // 恢复显示上传按钮
      progressContainer.classList.remove('show');
      warningBanner.classList.remove('show');
      cancelBtn.classList.remove('show');

      // 恢复显示上传区域、已选文件列表和重新生成按钮
      uploadArea.style.display = '';
      selectedFiles.style.display = '';
      regenerateBtn.style.display = '';

      if (compressionPollInterval) {
        clearInterval(compressionPollInterval);
        compressionPollInterval = null;
      }
    }

    // 取消上传
    cancelBtn.addEventListener('click', () => {
      if (uploadXHR) {
        uploadXHR.abort();
      }
      if (compressionPollInterval) {
        clearInterval(compressionPollInterval);
      }
      showResult('上传已取消', 'error');
      resetUpload();
    });

    // 显示结果
    function showResult(message, type) {
      result.className = 'result show ' + type;
      if (type === 'success') {
        result.innerHTML = message;
      } else {
        result.innerHTML = '<h3>❌ ' + message + '</h3>';
      }
    }

    // 页面离开警告
    window.addEventListener('beforeunload', (e) => {
      if (isUploading) {
        e.preventDefault();
        e.returnValue = '上传未完成，离开网页会丢失所有已上传内容！确定要离开吗？';
        return e.returnValue;
      }
    });
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
