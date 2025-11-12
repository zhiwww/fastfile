/**
 * FastFile - 业务逻辑处理器
 * 包含所有请求处理函数和文件操作逻辑
 */

import { AwsClient } from 'aws4fetch';
import { Zip, ZipPassThrough } from 'fflate';
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
export const compressionProgress = new Map();

/**
 * 初始化分块上传 (Phase 1)
 */
export async function handleUploadInit(request, env, logger, metrics, CONFIG, retryWithBackoff, getAwsClient, getR2Url, parseXmlResponse) {
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

    // 为每个文件创建multipart upload并生成预签名 URL
    const fileUploads = [];
    for (const file of files) {
      const tempKey = `temp/${uploadId}/${file.name}`;
      const fileStartTime = Date.now();

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

      // 🔧 新增：为每个 part 生成预签名 URL
      const parts = [];
      const presignStartTime = Date.now();

      for (let partNumber = 1; partNumber <= totalChunks; partNumber++) {
        // 生成签名请求信息
        const uploadUrl = `${r2Url}/${tempKey}?partNumber=${partNumber}&uploadId=${encodeURIComponent(xmlResult.UploadId)}`;

        const signedRequest = await awsClient.sign(uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream'
          }
        });

        // 提取签名headers（包含AWS签名认证信息）
        const signedHeaders = {};
        signedRequest.headers.forEach((value, key) => {
          signedHeaders[key] = value;
        });

        parts.push({
          partNumber,
          uploadUrl: signedRequest.url,  // R2 endpoint URL
          headers: signedHeaders          // 🔧 新增：签名headers
        });
      }

      const presignDuration = Date.now() - presignStartTime;
      requestLogger.info('Generated presigned URLs', {
        fileName: file.name,
        totalChunks,
        presignDuration: `${presignDuration}ms`
      });

      fileUploads.push({
        name: file.name,
        size: file.size,
        key: tempKey,
        uploadId: xmlResult.UploadId,
        totalChunks,
        parts  // 🔧 新增：返回预签名 URL 列表
      });

      const fileInitDuration = Date.now() - fileStartTime;
      requestLogger.info('File init completed', {
        fileName: file.name,
        totalDuration: `${fileInitDuration}ms`
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

    requestLogger.info('Upload init completed', {
      uploadId,
      filesCount: files.length,
      totalChunks: fileUploads.reduce((sum, f) => sum + f.totalChunks, 0)
    });

    return jsonResponse({
      success: true,
      uploadId,
      files: fileUploads.map(f => ({
        name: f.name,
        totalChunks: f.totalChunks,
        uploadId: f.uploadId,
        parts: f.parts  // 🔧 新增：返回预签名 URL
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
export async function handleUploadChunk(request, env, logger, metrics, CONFIG, retryWithBackoff, getAwsClient, getR2Url) {
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
 * 🔧 新增：确认 chunk 上传（前端直接上传到 R2 后调用）
 * 此端点非常轻量级，不处理文件数据，只记录 ETag
 */
export async function handleUploadChunkConfirm(request, env, logger, metrics) {
  const requestLogger = logger ? logger.child({ handler: 'upload.chunk.confirm' }) : { info: () => { }, warn: () => { }, error: () => { } };
  const t0 = Date.now();

  try {
    const { uploadId, fileName, chunkIndex, partNumber, etag } = await request.json();

    const t1 = Date.now();
    console.log(`⏱️ [ChunkConfirm] Parse request: ${t1 - t0}ms`);

    // 验证参数
    if (!uploadId || !fileName || chunkIndex === undefined || !partNumber || !etag) {
      requestLogger.warn('Missing required parameters', { uploadId, fileName, chunkIndex, partNumber, etag });
      return errorResponse('缺少必要参数', 400);
    }

    // ⭐ 并行获取：上传元数据 + 检查是否已存在
    const chunkKey = `upload:${uploadId}:chunk:${fileName}:${chunkIndex}`;

    const [metaStr, existingChunk] = await Promise.all([
      env.FILE_META.get(`upload:${uploadId}`),
      env.FILE_META.get(chunkKey)
    ]);

    if (!metaStr) {
      return errorResponse('上传不存在', 404);
    }

    const t2 = Date.now();
    console.log(`⏱️ [ChunkConfirm] Get meta (parallel): ${t2 - t1}ms`);

    const meta = JSON.parse(metaStr);
    const fileUpload = meta.files.find(f => f.name === fileName);

    if (!fileUpload) {
      return errorResponse('文件不存在', 404);
    }

    // ⭐ 准备写入操作
    const chunkData = {
      partNumber,
      etag,
      fileName,
      chunkIndex,
      uploadedAt: Date.now()
    };

    // ⭐ 更新计数器（只在新增时）
    const isNewChunk = !existingChunk;
    let uploadedCount = meta.uploadedCount || 0;
    let needsMetaUpdate = false;

    if (isNewChunk) {
      uploadedCount++;
      meta.uploadedCount = uploadedCount;
      needsMetaUpdate = true;
    }

    // ⭐ 并行写入：chunk 数据 + 元数据（如果需要）
    const writePromises = [
      env.FILE_META.put(chunkKey, JSON.stringify(chunkData))
    ];

    if (needsMetaUpdate) {
      writePromises.push(
        env.FILE_META.put(`upload:${uploadId}`, JSON.stringify(meta))
      );
    }

    await Promise.all(writePromises);

    const t3 = Date.now();
    console.log(`⏱️ [ChunkConfirm] Save (parallel writes): ${t3 - t2}ms`);

    requestLogger.info('Chunk confirmed', {
      uploadId,
      fileName,
      chunkIndex,
      partNumber,
      isNewChunk,
      uploadedCount,
      etag: etag.substring(0, 10) + '...'
    });

    // ⭐ 计算进度 - O(1) 操作
    const totalChunks = meta.files.reduce((sum, f) => sum + f.totalChunks, 0);
    const progress = (uploadedCount / totalChunks) * 100;

    const totalDuration = Date.now() - t0;
    console.log(`⏱️ [ChunkConfirm] Total: ${totalDuration}ms (optimized, target: <100ms)`);

    if (metrics) {
      metrics.timing('chunk.confirm.duration', totalDuration);
      metrics.increment('chunk.confirm.success', 1);
      metrics.gauge('chunk.confirm.uploaded_count', uploadedCount);
    }

    return jsonResponse({
      success: true,
      uploaded: uploadedCount,
      total: totalChunks,
      overallProgress: progress.toFixed(2),
      isNewChunk  // 告诉客户端是否是重复提交
    });

  } catch (error) {
    console.error('❌ [ChunkConfirm] Error:', error);
    if (logger) logger.error('Chunk confirm failed', { error: error.message });
    if (metrics) metrics.increment('chunk.confirm.error', 1);
    return errorResponse('确认上传失败: ' + error.message, 500);
  }
}

/**
 * 完成上传并触发压缩
 */
export async function handleUploadComplete(request, env, ctx, logger, metrics, CONFIG, retryWithBackoff, getAwsClient, getR2Url, performCompression) {
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
    // 🚀 优化：使用 KV List API + 并行读取，大幅提升性能
    // 性能提升：对于 1000 chunks，从 ~20秒 → ~2秒 (10倍提升)
    const filesStatus = [];

    for (const fileUpload of meta.files) {
      const prefix = `upload:${uploadId}:chunk:${fileUpload.name}:`;

      // 🚀 使用 List API 获取该文件的所有 chunk keys (单次调用)
      const chunkList = await env.FILE_META.list({ prefix });

      requestLogger.info('Fetched chunk keys via List API', {
        fileName: fileUpload.name,
        keysFound: chunkList.keys.length,
        expectedChunks: fileUpload.totalChunks
      });

      // 🚀 并行读取所有 chunks
      const chunkPromises = chunkList.keys.map(async (key) => {
        const chunkDataStr = await env.FILE_META.get(key.name);
        if (chunkDataStr) {
          return JSON.parse(chunkDataStr);
        }
        return null;
      });

      const chunks = (await Promise.all(chunkPromises)).filter(c => c !== null);

      // 按 partNumber 排序（确保顺序正确）
      chunks.sort((a, b) => a.partNumber - b.partNumber);

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
export async function handleUploadStatus(uploadId, env) {
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
 * 获取aws4fetch客户端 (内部辅助函数)
 */
function getAwsClient(env) {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  });
}

/**
 * 获取R2 bucket URL (内部辅助函数)
 */
function getR2Url(env) {
  const accountId = env.R2_ACCOUNT_ID;
  const bucketName = env.R2_BUCKET_NAME || 'fastfile-storage';
  return `https://${accountId}.r2.cloudflarestorage.com/${bucketName}`;
}

/**
 * 执行实际的压缩操作
 * 🔧 使用流式压缩避免内存溢出
 * 🔧 智能环境检测：生产环境用 R2 binding，本地开发用 S3 API
 */
export async function performCompression(uploadId, uploadMeta, env) {
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
export async function handleVerify(request, env) {
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
export async function handleDownload(fileId, request, env) {
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
export async function cleanupExpiredFiles(env) {
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
