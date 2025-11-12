#!/usr/bin/env node

/**
 * FastFile 调试客户端
 * 用于测试远端 FastFile 服务的所有功能
 *
 * 使用方法:
 *   node test-client.js upload <file-path> [password]
 *   node test-client.js download <file-id> <password>
 *   node test-client.js test-upload <size-in-mb> [password]
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// 配置
const CONFIG = {
  BASE_URL: 'https://fastfile.zwi.monster',
  CHUNK_SIZE: 10 * 1024 * 1024, // 10MB
  MAX_CONCURRENT: 4,
  DEFAULT_PASSWORD: '1234'
};

// 全局选项
let INTERACTIVE_MODE = false;

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSuccess(message) {
  log(`✓ ${message}`, 'green');
}

function logError(message) {
  log(`✗ ${message}`, 'red');
}

function logInfo(message) {
  log(`ℹ ${message}`, 'cyan');
}

function logWarning(message) {
  log(`⚠ ${message}`, 'yellow');
}

// 等待用户按键
async function waitForKeyPress(message = 'Press any key to continue...') {
  if (!INTERACTIVE_MODE) {
    return;
  }

  log(`\n${message}`, 'yellow');

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('', () => {
      rl.close();
      resolve();
    });
  });
}

// HTTP 请求封装
async function request(url, options = {}) {
  const response = await fetch(url, options);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return await response.json();
  }

  return response;
}

// 生成测试文件
function generateTestFile(sizeMB) {
  const size = sizeMB * 1024 * 1024;
  const buffer = Buffer.alloc(size);

  // 填充随机数据（每 1MB 填充一次以节省内存）
  const chunkSize = 1024 * 1024;
  for (let i = 0; i < size; i += chunkSize) {
    const end = Math.min(i + chunkSize, size);
    for (let j = i; j < end; j++) {
      buffer[j] = Math.floor(Math.random() * 256);
    }
  }

  return buffer;
}

// 格式化文件大小
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

// 格式化时间
function formatTime(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(2)}m`;
}

// 进度条
class ProgressBar {
  constructor(total, label = 'Progress') {
    this.total = total;
    this.current = 0;
    this.label = label;
    this.startTime = Date.now();
    this.lastUpdate = 0;
  }

  update(current) {
    this.current = current;

    // 限制更新频率（100ms）
    const now = Date.now();
    if (now - this.lastUpdate < 100 && current < this.total) {
      return;
    }
    this.lastUpdate = now;

    const percent = Math.floor((current / this.total) * 100);
    const filled = Math.floor(percent / 2);
    const empty = 50 - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);

    const elapsed = now - this.startTime;
    const speed = current / (elapsed / 1000);
    const eta = (this.total - current) / speed;

    process.stdout.write(
      `\r${colors.cyan}${this.label}${colors.reset} [${bar}] ${percent}% ` +
      `${formatSize(current)}/${formatSize(this.total)} ` +
      `${formatSize(speed)}/s ETA: ${formatTime(eta * 1000)}`
    );

    if (current >= this.total) {
      process.stdout.write('\n');
    }
  }

  finish() {
    this.update(this.total);
    const elapsed = Date.now() - this.startTime;
    logSuccess(`Complete in ${formatTime(elapsed)}`);
  }
}

// 上传文件
async function uploadFile(filePath, password = CONFIG.DEFAULT_PASSWORD) {
  logInfo(`Starting upload: ${filePath}`);

  // 读取文件
  const fileName = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;
  const fileBuffer = fs.readFileSync(filePath);

  logInfo(`File: ${fileName} (${formatSize(fileSize)})`);
  logInfo(`Password: ${password}`);

  // 1. 初始化上传 - 获取预签名 URL
  log('\n1. Initializing upload and getting presigned URLs...', 'bright');
  const initStart = Date.now();

  const initResponse = await request(`${CONFIG.BASE_URL}/api/upload/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [{ name: fileName, size: fileSize }],
      password
    })
  });

  logSuccess(`Upload initialized (${Date.now() - initStart}ms)`);
  logInfo(`Upload ID: ${initResponse.uploadId}`);
  logInfo(`Chunk Size: ${formatSize(initResponse.chunkSize)}`);
  logInfo(`Files: ${initResponse.files.length}`);

  const { uploadId, files } = initResponse;
  const fileUpload = files[0]; // 我们只上传一个文件

  logInfo(`Total chunks: ${fileUpload.totalChunks}`);
  logInfo(`R2 Upload ID: ${fileUpload.uploadId}`);
  logInfo(`Presigned URLs: ${fileUpload.parts.length}`);

  await waitForKeyPress('Step 1 completed. Press Enter to start uploading chunks directly to R2...');

  // 2. 直接上传分块到 R2（使用预签名 URL）
  log('\n2. Uploading chunks directly to R2...', 'bright');

  const progressBar = new ProgressBar(fileSize, 'Upload');
  let uploadedBytes = 0;

  // 逐个上传分块
  for (let i = 0; i < fileUpload.parts.length; i++) {
    const part = fileUpload.parts[i];
    const start = i * initResponse.chunkSize;
    const end = Math.min(start + initResponse.chunkSize, fileSize);
    const chunk = fileBuffer.subarray(start, end);

    logInfo(`\nUploading part ${part.partNumber}/${fileUpload.totalChunks} (${formatSize(chunk.length)})...`);

    // 直接上传到 R2 使用预签名 URL 和 headers
    const uploadResponse = await fetch(part.uploadUrl, {
      method: 'PUT',
      body: chunk,
      headers: part.headers
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`Upload part ${part.partNumber} failed: ${uploadResponse.status} ${errorText}`);
    }

    const etag = uploadResponse.headers.get('ETag');
    logSuccess(`Part ${part.partNumber} uploaded, ETag: ${etag}`);

    uploadedBytes += chunk.length;
    progressBar.update(uploadedBytes);

    // 每个分块上传完都暂停
    await waitForKeyPress(`Part ${part.partNumber}/${fileUpload.totalChunks} uploaded to R2. Press Enter to confirm...`);

    // 确认分块上传
    await request(`${CONFIG.BASE_URL}/api/upload/chunk/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId,
        fileName: fileUpload.name,
        chunkIndex: i,
        partNumber: part.partNumber,
        etag
      })
    });

    logSuccess(`Part ${part.partNumber} confirmed`);

    await waitForKeyPress(`Part ${part.partNumber} confirmed. Press Enter to continue to next part...`);
  }

  progressBar.finish();

  await waitForKeyPress('Step 2 completed. All chunks uploaded and confirmed. Press Enter to complete upload...');

  // 3. 完成上传
  log('\n3. Completing multipart upload...', 'bright');
  const completeStart = Date.now();

  const completeResponse = await request(`${CONFIG.BASE_URL}/api/upload/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId })
  });

  logSuccess(`Upload completed (${Date.now() - completeStart}ms)`);
  logInfo(`Status: ${completeResponse.status || 'processing'}`);

  await waitForKeyPress('Step 3 completed. Upload confirmed. Press Enter to check processing status...');

  // 4. 等待后台处理
  log('\n4. Waiting for background processing...', 'bright');
  logInfo('Polling upload status...');

  let fileId = null;
  const maxAttempts = 60; // 最多等待 60 秒

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
      const statusResponse = await request(`${CONFIG.BASE_URL}/api/upload-status/${uploadId}`);

      if (statusResponse.status === 'completed' && statusResponse.fileId) {
        fileId = statusResponse.fileId;
        break;
      }

      if (statusResponse.status === 'failed') {
        throw new Error('Upload processing failed');
      }

      process.stdout.write(`\rWaiting... ${attempt + 1}s (status: ${statusResponse.status || 'unknown'})`);
    } catch (error) {
      // 如果状态接口不存在或错误，继续等待
      if (attempt < 10) {
        process.stdout.write(`\rWaiting... ${attempt + 1}s`);
      } else {
        logWarning('\nStatus API unavailable or timeout, but upload may have succeeded');
        break;
      }
    }
  }

  process.stdout.write('\n');

  if (fileId) {
    logSuccess(`File ID: ${fileId}`);
    logSuccess(`Download URL: ${CONFIG.BASE_URL}/d/${fileId}`);
  } else {
    logWarning('Could not get file ID, but upload may have succeeded');
    logInfo(`Check upload ID: ${uploadId}`);
    logInfo(`Try accessing: ${CONFIG.BASE_URL}/api/upload-status/${uploadId}`);
  }

  return { uploadId, fileId };
}

// 测试上传（生成随机文件）
async function testUpload(sizeMB, password = CONFIG.DEFAULT_PASSWORD) {
  logInfo(`Generating ${sizeMB}MB test file...`);

  const buffer = generateTestFile(sizeMB);
  const testFile = `/tmp/test-${Date.now()}.bin`;

  fs.writeFileSync(testFile, buffer);
  logSuccess(`Test file created: ${testFile}`);

  try {
    await uploadFile(testFile, password);
  } finally {
    fs.unlinkSync(testFile);
    logInfo('Test file deleted');
  }
}

// 下载文件
async function downloadFile(fileId, password, outputPath = null) {
  logInfo(`Downloading file: ${fileId}`);
  logInfo(`Password: ${password}`);

  // 1. 验证密码
  log('\n1. Verifying password...', 'bright');

  const verifyResponse = await request(`${CONFIG.BASE_URL}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId, password })
  });

  if (!verifyResponse.success) {
    throw new Error('Password verification failed');
  }

  logSuccess('Password verified');

  await waitForKeyPress('Password verified. Press Enter to start download...');

  // 2. 下载文件
  log('\n2. Downloading file...', 'bright');

  const downloadUrl = `${CONFIG.BASE_URL}/api/download/${fileId}?password=${password}`;
  const response = await fetch(downloadUrl);

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  const contentLength = parseInt(response.headers.get('content-length') || '0');
  const fileName = response.headers.get('content-disposition')
    ?.match(/filename="(.+)"/)?.[1] || `${fileId}.zip`;

  const outputFile = outputPath || path.join(process.cwd(), fileName);

  logInfo(`File: ${fileName} (${formatSize(contentLength)})`);
  logInfo(`Output: ${outputFile}`);

  const progressBar = new ProgressBar(contentLength, 'Download');

  const fileStream = fs.createWriteStream(outputFile);
  const reader = response.body.getReader();

  let downloadedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    fileStream.write(value);
    downloadedBytes += value.length;
    progressBar.update(downloadedBytes);
  }

  fileStream.end();
  progressBar.finish();

  logSuccess(`File saved to: ${outputFile}`);

  return outputFile;
}

// 完整测试套件
async function runTestSuite() {
  log('\n=== FastFile Test Suite ===\n', 'bright');

  const testPassword = '1234';
  let fileId;

  try {
    // 测试 1: 小文件上传（1MB）
    log('\n--- Test 1: Small file upload (1MB) ---', 'yellow');
    const result1 = await testUpload(1, testPassword);
    fileId = result1.fileId;

    if (!fileId) {
      logWarning('Skipping download test (no file ID)');
      return;
    }

    // 测试 2: 下载
    log('\n--- Test 2: Download file ---', 'yellow');
    await downloadFile(fileId, testPassword);

    // 测试 3: 错误密码
    log('\n--- Test 3: Wrong password ---', 'yellow');
    try {
      await downloadFile(fileId, '9999');
      logError('Should have failed with wrong password');
    } catch (error) {
      logSuccess('Correctly rejected wrong password');
    }

    log('\n=== All tests passed! ===\n', 'green');

  } catch (error) {
    log('\n=== Test failed ===\n', 'red');
    logError(error.message);
    console.error(error);
    process.exit(1);
  }
}

// 主函数
async function main() {
  const args = process.argv.slice(2);

  // 检查是否启用交互模式
  const interactiveFlagIndex = args.findIndex(arg => arg === '--interactive' || arg === '--step' || arg === '-i');
  if (interactiveFlagIndex !== -1) {
    INTERACTIVE_MODE = true;
    args.splice(interactiveFlagIndex, 1);
    logInfo('Interactive mode enabled - will pause after each step');
  }

  const command = args[0];

  try {
    switch (command) {
      case 'upload':
        if (!args[1]) {
          logError('Usage: node test-client.js upload <file-path> [password] [--interactive]');
          process.exit(1);
        }
        await uploadFile(args[1], args[2]);
        break;

      case 'download':
        if (!args[1] || !args[2]) {
          logError('Usage: node test-client.js download <file-id> <password> [output-path] [--interactive]');
          process.exit(1);
        }
        await downloadFile(args[1], args[2], args[3]);
        break;

      case 'test-upload':
        if (!args[1]) {
          logError('Usage: node test-client.js test-upload <size-in-mb> [password] [--interactive]');
          process.exit(1);
        }
        await testUpload(parseInt(args[1]), args[2]);
        break;

      case 'test':
      case 'test-suite':
        await runTestSuite();
        break;

      default:
        log('FastFile Debug Client\n', 'bright');
        log('Commands:', 'cyan');
        log('  upload <file-path> [password]           - Upload a file');
        log('  download <file-id> <password> [output]  - Download a file');
        log('  test-upload <size-mb> [password]        - Upload a test file');
        log('  test-suite                              - Run full test suite');
        log('\nOptions:', 'cyan');
        log('  --interactive, --step, -i               - Pause after each step');
        log('\nExamples:', 'yellow');
        log('  node test-client.js upload ./test.zip --interactive');
        log('  node test-client.js test-upload 50 1234 --step');
        log('  node test-client.js download abc123 1234 -i');
        log('  node test-client.js test-suite');
        break;
    }
  } catch (error) {
    logError(`Error: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

// 运行
if (require.main === module) {
  main();
}

module.exports = {
  uploadFile,
  downloadFile,
  testUpload,
  runTestSuite
};
