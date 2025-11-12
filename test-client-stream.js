#!/usr/bin/env node

/**
 * FastFile 测试客户端 - 流式读取版本
 * 只读取需要的分块，不加载整个文件到内存
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// 配置
const CONFIG = {
  BASE_URL: 'https://fastfile.zwi.monster',
  CHUNK_SIZE: 5 * 1024 * 1024, // 5MB
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

// 流式读取文件分块
function readChunkFromFile(filePath, start, size) {
  return new Promise((resolve, reject) => {
    const buffer = Buffer.alloc(size);
    const fd = fs.openSync(filePath, 'r');

    try {
      const bytesRead = fs.readSync(fd, buffer, 0, size, start);
      fs.closeSync(fd);

      if (bytesRead < size) {
        // 最后一个分块可能小于size
        resolve(buffer.slice(0, bytesRead));
      } else {
        resolve(buffer);
      }
    } catch (error) {
      fs.closeSync(fd);
      reject(error);
    }
  });
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

    const memUsage = process.memoryUsage();
    const heapMB = (memUsage.heapUsed / 1024 / 1024).toFixed(0);

    process.stdout.write(
      `\r${colors.cyan}${this.label}${colors.reset} [${bar}] ${percent}% ` +
      `${formatSize(current)}/${formatSize(this.total)} ` +
      `${formatSize(speed)}/s ETA: ${formatTime(eta * 1000)} ` +
      `Mem: ${heapMB}MB`
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

// 上传文件（流式读取版本）
async function uploadFileStream(filePath, password = CONFIG.DEFAULT_PASSWORD) {
  logInfo(`Starting upload (STREAM MODE): ${filePath}`);

  const fileName = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;

  logInfo(`File: ${fileName} (${formatSize(fileSize)})`);
  logInfo(`Password: ${password}`);
  logInfo(`Memory mode: Stream (no full file load)`);

  // 初始内存
  const initialMem = process.memoryUsage();
  logInfo(`Initial memory: Heap=${formatSize(initialMem.heapUsed)}, RSS=${formatSize(initialMem.rss)}`);

  // 1. 初始化上传
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

  const { uploadId, files } = initResponse;
  const fileUpload = files[0];

  logInfo(`Total chunks: ${fileUpload.totalChunks}`);
  logInfo(`Presigned URLs: ${fileUpload.parts.length}`);

  await waitForKeyPress('Step 1 completed. Press Enter to start uploading...');

  // 2. 逐个上传分块（流式读取）
  log('\n2. Uploading chunks (stream read)...', 'bright');

  const progressBar = new ProgressBar(fileSize, 'Upload');
  let uploadedBytes = 0;

  for (let i = 0; i < fileUpload.parts.length; i++) {
    const part = fileUpload.parts[i];
    const start = i * initResponse.chunkSize;
    const chunkSize = Math.min(initResponse.chunkSize, fileSize - start);

    // 🔧 关键改进：流式读取，每次只读取需要的分块
    const chunkReadStart = Date.now();
    const chunk = await readChunkFromFile(filePath, start, chunkSize);
    const chunkReadTime = Date.now() - chunkReadStart;

    const currentMem = process.memoryUsage();

    logInfo(`\nPart ${part.partNumber}/${fileUpload.totalChunks}:`);
    logInfo(`  Chunk size: ${formatSize(chunk.length)}`);
    logInfo(`  Read time: ${chunkReadTime}ms`);
    logInfo(`  Memory: Heap=${formatSize(currentMem.heapUsed)}, RSS=${formatSize(currentMem.rss)}`);

    // 上传到 R2
    const uploadStart = Date.now();

    const uploadResponse = await fetch(part.uploadUrl, {
      method: 'PUT',
      body: chunk,
      headers: part.headers
    });

    const uploadTime = Date.now() - uploadStart;

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`Upload part ${part.partNumber} failed: ${uploadResponse.status} ${errorText}`);
    }

    const etag = uploadResponse.headers.get('ETag');
    const uploadSpeed = (chunk.length / 1024 / 1024) / (uploadTime / 1000);

    logSuccess(`  Uploaded in ${uploadTime}ms (${uploadSpeed.toFixed(2)} MB/s)`);
    logInfo(`  ETag: ${etag}`);

    uploadedBytes += chunk.length;
    progressBar.update(uploadedBytes);

    await waitForKeyPress(`Part ${part.partNumber} uploaded. Press Enter to confirm...`);

    // 确认分块
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

    logSuccess(`  Confirmed`);

    await waitForKeyPress(`Part ${part.partNumber} confirmed. Press Enter to continue...`);
  }

  progressBar.finish();

  // 最终内存
  const finalMem = process.memoryUsage();
  logInfo(`Final memory: Heap=${formatSize(finalMem.heapUsed)}, RSS=${formatSize(finalMem.rss)}`);
  logInfo(`Memory delta: Heap=${formatSize(finalMem.heapUsed - initialMem.heapUsed)}, RSS=${formatSize(finalMem.rss - initialMem.rss)}`);

  await waitForKeyPress('All chunks uploaded. Press Enter to complete...');

  // 3. 完成上传
  log('\n3. Completing upload...', 'bright');

  const completeResponse = await request(`${CONFIG.BASE_URL}/api/upload/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId })
  });

  logSuccess('Upload completed');

  await waitForKeyPress('Upload completed. Press Enter to check status...');

  // 4. 查询状态
  log('\n4. Checking status...', 'bright');

  let fileId = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
      const statusResponse = await request(`${CONFIG.BASE_URL}/api/upload-status/${uploadId}`);

      if (statusResponse.status === 'completed' && statusResponse.fileId) {
        fileId = statusResponse.fileId;
        break;
      }

      process.stdout.write(`\rWaiting... ${i + 1}s (${statusResponse.status})`);
    } catch (error) {
      if (i > 10) {
        logWarning('\nStatus check timeout');
        break;
      }
    }
  }

  process.stdout.write('\n');

  if (fileId) {
    logSuccess(`File ID: ${fileId}`);
    logSuccess(`URL: ${CONFIG.BASE_URL}/d/${fileId}`);
  }

  return { uploadId, fileId };
}

// 主函数
async function main() {
  const args = process.argv.slice(2);

  const interactiveFlagIndex = args.findIndex(arg => arg === '--interactive' || arg === '-i');
  if (interactiveFlagIndex !== -1) {
    INTERACTIVE_MODE = true;
    args.splice(interactiveFlagIndex, 1);
  }

  const filePath = args[0];

  if (!filePath) {
    log('Usage: node test-client-stream.js <file-path> [--interactive]', 'yellow');
    log('\nExample:', 'cyan');
    log('  node test-client-stream.js /path/to/large-file.bin --interactive');
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    logError(`File not found: ${filePath}`);
    process.exit(1);
  }

  try {
    await uploadFileStream(filePath, CONFIG.DEFAULT_PASSWORD);
  } catch (error) {
    logError(`Error: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { uploadFileStream };
