#!/usr/bin/env node

/**
 * FastFile 上传性能诊断工具
 * 用于分析不同文件大小对分块上传速度的影响
 */

const fs = require('fs');
const path = require('path');

const CONFIG = {
  BASE_URL: 'https://fastfile.zwi.monster',
  CHUNK_SIZE: 5 * 1024 * 1024, // 5MB
  DEFAULT_PASSWORD: '1234'
};

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

function formatTime(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
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

// 性能测量工具
class PerformanceMonitor {
  constructor(label) {
    this.label = label;
    this.marks = {};
    this.measures = {};
  }

  mark(name) {
    this.marks[name] = {
      time: Date.now(),
      memory: process.memoryUsage()
    };
  }

  measure(name, startMark, endMark) {
    const start = this.marks[startMark];
    const end = this.marks[endMark];

    if (!start || !end) {
      throw new Error(`Mark not found: ${startMark} or ${endMark}`);
    }

    const duration = end.time - start.time;
    const memoryDelta = {
      heapUsed: end.memory.heapUsed - start.memory.heapUsed,
      heapTotal: end.memory.heapTotal - start.memory.heapTotal,
      rss: end.memory.rss - start.memory.rss
    };

    this.measures[name] = { duration, memoryDelta };
    return { duration, memoryDelta };
  }

  report() {
    log(`\n=== Performance Report: ${this.label} ===`, 'cyan');

    for (const [name, data] of Object.entries(this.measures)) {
      log(`\n${name}:`, 'yellow');
      log(`  Duration: ${formatTime(data.duration)}`);
      log(`  Memory Delta:`);
      log(`    Heap Used: ${formatSize(Math.abs(data.memoryDelta.heapUsed))} ${data.memoryDelta.heapUsed > 0 ? '↑' : '↓'}`);
      log(`    Heap Total: ${formatSize(Math.abs(data.memoryDelta.heapTotal))} ${data.memoryDelta.heapTotal > 0 ? '↑' : '↓'}`);
      log(`    RSS: ${formatSize(Math.abs(data.memoryDelta.rss))} ${data.memoryDelta.rss > 0 ? '↑' : '↓'}`);
    }
  }
}

// 生成测试文件（使用流式写入，避免内存问题）
async function generateTestFileStream(sizeMB, filePath) {
  const size = sizeMB * 1024 * 1024;
  const chunkSize = 1024 * 1024; // 1MB per write

  const writeStream = fs.createWriteStream(filePath);

  return new Promise((resolve, reject) => {
    let written = 0;

    const writeChunk = () => {
      while (written < size) {
        const remaining = size - written;
        const toWrite = Math.min(chunkSize, remaining);

        // 生成随机数据
        const buffer = Buffer.alloc(toWrite);
        for (let i = 0; i < toWrite; i++) {
          buffer[i] = Math.floor(Math.random() * 256);
        }

        const canContinue = writeStream.write(buffer);
        written += toWrite;

        if (!canContinue) {
          writeStream.once('drain', writeChunk);
          return;
        }
      }

      writeStream.end();
    };

    writeStream.on('finish', () => resolve(filePath));
    writeStream.on('error', reject);

    writeChunk();
  });
}

// 测试单个文件上传的第一个分块
async function testFirstChunkUpload(fileSize, method = 'sync') {
  const monitor = new PerformanceMonitor(`${fileSize}MB file - ${method} read`);

  log(`\n${'='.repeat(60)}`, 'cyan');
  log(`Testing ${fileSize}MB file (${method} read)`, 'cyan');
  log('='.repeat(60), 'cyan');

  // 1. 生成测试文件
  log('\n[1/6] Generating test file...', 'yellow');
  monitor.mark('generate-start');

  const testFile = `/tmp/fastfile-test-${fileSize}mb.bin`;
  await generateTestFileStream(fileSize, testFile);

  monitor.mark('generate-end');
  monitor.measure('File Generation', 'generate-start', 'generate-end');

  const stats = fs.statSync(testFile);
  log(`  File created: ${formatSize(stats.size)}`, 'green');

  try {
    // 2. 读取文件到内存
    log('\n[2/6] Reading file into memory...', 'yellow');
    monitor.mark('read-start');

    let fileBuffer;
    if (method === 'sync') {
      // 同步读取整个文件
      fileBuffer = fs.readFileSync(testFile);
    } else {
      // 流式读取（仅读取第一个分块）
      const firstChunkSize = CONFIG.CHUNK_SIZE;
      fileBuffer = Buffer.alloc(firstChunkSize);
      const fd = fs.openSync(testFile, 'r');
      fs.readSync(fd, fileBuffer, 0, firstChunkSize, 0);
      fs.closeSync(fd);
    }

    monitor.mark('read-end');
    monitor.measure('File Read', 'read-start', 'read-end');

    log(`  Buffer size: ${formatSize(fileBuffer.length)}`, 'green');
    log(`  Memory after read:`, 'cyan');
    const mem = process.memoryUsage();
    log(`    Heap Used: ${formatSize(mem.heapUsed)}`);
    log(`    Heap Total: ${formatSize(mem.heapTotal)}`);
    log(`    RSS: ${formatSize(mem.rss)}`);

    // 3. 初始化上传
    log('\n[3/6] Initializing upload...', 'yellow');
    monitor.mark('init-start');

    const initResponse = await request(`${CONFIG.BASE_URL}/api/upload/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [{ name: path.basename(testFile), size: stats.size }],
        password: CONFIG.DEFAULT_PASSWORD
      })
    });

    monitor.mark('init-end');
    monitor.measure('Upload Init', 'init-start', 'init-end');

    log(`  Upload ID: ${initResponse.uploadId}`, 'green');
    log(`  Presigned URLs: ${initResponse.files[0].parts.length}`, 'green');

    // 4. 提取第一个分块
    log('\n[4/6] Extracting first chunk...', 'yellow');
    monitor.mark('extract-start');

    const firstChunk = fileBuffer.subarray(0, CONFIG.CHUNK_SIZE);

    monitor.mark('extract-end');
    monitor.measure('Chunk Extract', 'extract-start', 'extract-end');

    log(`  Chunk size: ${formatSize(firstChunk.length)}`, 'green');

    // 5. 上传第一个分块到 R2
    log('\n[5/6] Uploading first chunk to R2...', 'yellow');
    const part = initResponse.files[0].parts[0];

    monitor.mark('upload-start');
    const uploadStartTime = Date.now();

    const uploadResponse = await fetch(part.uploadUrl, {
      method: 'PUT',
      body: firstChunk,
      headers: part.headers
    });

    const uploadEndTime = Date.now();
    monitor.mark('upload-end');
    monitor.measure('R2 Upload', 'upload-start', 'upload-end');

    if (!uploadResponse.ok) {
      throw new Error(`Upload failed: ${uploadResponse.status}`);
    }

    const uploadDuration = uploadEndTime - uploadStartTime;
    const uploadSpeed = (firstChunk.length / 1024 / 1024) / (uploadDuration / 1000);

    log(`  Upload time: ${formatTime(uploadDuration)}`, 'green');
    log(`  Upload speed: ${uploadSpeed.toFixed(2)} MB/s`, 'green');
    log(`  ETag: ${uploadResponse.headers.get('ETag')}`, 'cyan');

    // 6. 确认分块
    log('\n[6/6] Confirming chunk...', 'yellow');
    monitor.mark('confirm-start');

    await request(`${CONFIG.BASE_URL}/api/upload/chunk/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId: initResponse.uploadId,
        fileName: initResponse.files[0].name,
        chunkIndex: 0,
        partNumber: 1,
        etag: uploadResponse.headers.get('ETag')
      })
    });

    monitor.mark('confirm-end');
    monitor.measure('Chunk Confirm', 'confirm-start', 'confirm-end');

    log('  Confirmed', 'green');

    // 性能报告
    monitor.report();

    return {
      fileSize,
      method,
      uploadDuration,
      uploadSpeed,
      totalDuration: Date.now() - monitor.marks['generate-start'].time,
      memory: monitor.marks['read-end'].memory
    };

  } finally {
    // 清理测试文件
    fs.unlinkSync(testFile);
    log(`\nTest file deleted: ${testFile}`, 'cyan');
  }
}

// 对比测试
async function compareFileSizes() {
  log('\n╔══════════════════════════════════════════════════════════╗', 'magenta');
  log('║  FastFile Upload Performance Diagnostic Tool            ║', 'magenta');
  log('║  Comparing first chunk upload speed for different sizes ║', 'magenta');
  log('╚══════════════════════════════════════════════════════════╝', 'magenta');

  const testSizes = [10, 100, 1000]; // MB
  const results = [];

  for (const size of testSizes) {
    // 测试同步读取
    log(`\n\n${'█'.repeat(60)}`, 'magenta');
    const syncResult = await testFirstChunkUpload(size, 'sync');
    results.push(syncResult);

    // 等待一下，让系统稳定
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // 再测试流式读取（只读第一个分块）
  log('\n\n' + '█'.repeat(60), 'magenta');
  log('Testing with stream read (only first chunk)...', 'magenta');
  log('█'.repeat(60), 'magenta');

  for (const size of testSizes) {
    const streamResult = await testFirstChunkUpload(size, 'stream');
    results.push(streamResult);

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // 汇总报告
  log('\n\n╔══════════════════════════════════════════════════════════╗', 'cyan');
  log('║                    SUMMARY REPORT                        ║', 'cyan');
  log('╚══════════════════════════════════════════════════════════╝', 'cyan');

  log('\n┌─────────────┬────────────┬───────────────┬──────────────┬──────────────┐');
  log('│ File Size   │ Read Mode  │ Upload Speed  │ Upload Time  │ Memory (RSS) │');
  log('├─────────────┼────────────┼───────────────┼──────────────┼──────────────┤');

  for (const result of results) {
    const fileSizeStr = `${result.fileSize} MB`.padEnd(11);
    const methodStr = result.method.padEnd(10);
    const speedStr = `${result.uploadSpeed.toFixed(2)} MB/s`.padEnd(13);
    const timeStr = formatTime(result.uploadDuration).padEnd(12);
    const memStr = formatSize(result.memory.rss).padEnd(12);

    log(`│ ${fileSizeStr} │ ${methodStr} │ ${speedStr} │ ${timeStr} │ ${memStr} │`);
  }

  log('└─────────────┴────────────┴───────────────┴──────────────┴──────────────┘');

  // 分析
  log('\n╔══════════════════════════════════════════════════════════╗', 'yellow');
  log('║                       ANALYSIS                           ║', 'yellow');
  log('╚══════════════════════════════════════════════════════════╝', 'yellow');

  const syncResults = results.filter(r => r.method === 'sync');
  const streamResults = results.filter(r => r.method === 'stream');

  log('\n📊 Sync Read Mode:', 'cyan');
  for (let i = 0; i < syncResults.length; i++) {
    const current = syncResults[i];
    const baseline = syncResults[0];
    const speedDiff = ((current.uploadSpeed - baseline.uploadSpeed) / baseline.uploadSpeed * 100).toFixed(2);

    log(`  ${current.fileSize}MB: ${current.uploadSpeed.toFixed(2)} MB/s (${speedDiff > 0 ? '+' : ''}${speedDiff}% vs ${baseline.fileSize}MB)`);
  }

  log('\n📊 Stream Read Mode:', 'cyan');
  for (let i = 0; i < streamResults.length; i++) {
    const current = streamResults[i];
    const baseline = streamResults[0];
    const speedDiff = ((current.uploadSpeed - baseline.uploadSpeed) / baseline.uploadSpeed * 100).toFixed(2);

    log(`  ${current.fileSize}MB: ${current.uploadSpeed.toFixed(2)} MB/s (${speedDiff > 0 ? '+' : ''}${speedDiff}% vs ${baseline.fileSize}MB)`);
  }

  log('\n💡 Insights:', 'yellow');

  const sync100 = syncResults.find(r => r.fileSize === 100);
  const sync1000 = syncResults.find(r => r.fileSize === 1000);
  const speedDrop = ((sync1000.uploadSpeed - sync100.uploadSpeed) / sync100.uploadSpeed * 100);

  if (Math.abs(speedDrop) > 10) {
    log(`  ⚠️  Significant speed difference detected: ${speedDrop.toFixed(2)}%`, 'red');
    log(`     100MB -> 1000MB: ${sync100.uploadSpeed.toFixed(2)} MB/s -> ${sync1000.uploadSpeed.toFixed(2)} MB/s`);

    const memDiff = sync1000.memory.rss - sync100.memory.rss;
    log(`     Memory increase: ${formatSize(memDiff)}`, 'yellow');

    if (memDiff > 500 * 1024 * 1024) { // > 500MB
      log('\n  🔍 Possible cause: Memory pressure from loading entire file', 'yellow');
      log('     Recommendation: Use stream-based reading instead of fs.readFileSync()');
    }
  } else {
    log('  ✓ Upload speed is consistent across different file sizes', 'green');
  }

  const stream100 = streamResults.find(r => r.fileSize === 100);
  const stream1000 = streamResults.find(r => r.fileSize === 1000);
  const streamSpeedDrop = ((stream1000.uploadSpeed - stream100.uploadSpeed) / stream100.uploadSpeed * 100);

  if (Math.abs(streamSpeedDrop) < Math.abs(speedDrop)) {
    log('\n  ✓ Stream reading improves consistency', 'green');
    log(`     Speed variance: ${Math.abs(speedDrop).toFixed(2)}% (sync) -> ${Math.abs(streamSpeedDrop).toFixed(2)}% (stream)`);
  }
}

// 主函数
async function main() {
  try {
    await compareFileSizes();
  } catch (error) {
    log(`\n❌ Error: ${error.message}`, 'red');
    console.error(error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
