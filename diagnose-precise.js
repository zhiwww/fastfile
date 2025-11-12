#!/usr/bin/env node

/**
 * 精确对比测试 - 只测试第一个分块的上传速度
 * 排除其他因素的干扰
 */

const fs = require('fs');
const path = require('path');

const CONFIG = {
  BASE_URL: 'https://fastfile.zwi.monster',
  CHUNK_SIZE: 5 * 1024 * 1024,
  DEFAULT_PASSWORD: '1234'
};

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    return await response.json();
  }
  return response;
}

function formatSize(bytes) {
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(2)} MB`;
}

// 生成指定大小的测试文件
async function generateFile(sizeMB, filePath) {
  const size = sizeMB * 1024 * 1024;
  const chunkSize = 1024 * 1024;

  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(filePath);
    let written = 0;

    const writeNext = () => {
      while (written < size) {
        const remaining = size - written;
        const toWrite = Math.min(chunkSize, remaining);
        const buffer = Buffer.alloc(toWrite);

        // 填充随机数据
        for (let i = 0; i < toWrite; i++) {
          buffer[i] = Math.floor(Math.random() * 256);
        }

        const ok = stream.write(buffer);
        written += toWrite;

        if (!ok) {
          stream.once('drain', writeNext);
          return;
        }
      }
      stream.end();
    };

    stream.on('finish', () => resolve(filePath));
    stream.on('error', reject);
    writeNext();
  });
}

// 测试第一个分块的上传速度
async function testFirstChunk(fileSize, readMode = 'sync') {
  log(`\n${'='.repeat(70)}`, 'cyan');
  log(`Testing ${fileSize}MB file - ${readMode} read mode`, 'cyan');
  log('='.repeat(70), 'cyan');

  const testFile = `/tmp/fastfile-precise-test-${fileSize}mb.bin`;

  try {
    // 1. 生成文件
    log('\n[1] Generating file...', 'yellow');
    const genStart = Date.now();
    await generateFile(fileSize, testFile);
    log(`    Generated in ${Date.now() - genStart}ms`, 'green');

    const fileStat = fs.statSync(testFile);
    const fileName = path.basename(testFile);

    // 2. 初始化上传
    log('\n[2] Initializing upload...', 'yellow');
    const initStart = Date.now();

    const initResponse = await request(`${CONFIG.BASE_URL}/api/upload/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [{ name: fileName, size: fileStat.size }],
        password: CONFIG.DEFAULT_PASSWORD
      })
    });

    const initTime = Date.now() - initStart;
    log(`    Init time: ${initTime}ms`, 'green');
    log(`    Presigned URLs: ${initResponse.files[0].parts.length}`, 'cyan');

    // 3. 读取第一个分块
    log('\n[3] Reading first chunk...', 'yellow');

    const memBefore = process.memoryUsage();
    const readStart = Date.now();

    let chunk;
    if (readMode === 'sync') {
      // 读取整个文件
      const fileBuffer = fs.readFileSync(testFile);
      chunk = fileBuffer.subarray(0, CONFIG.CHUNK_SIZE);
    } else {
      // 只读取第一个分块
      chunk = Buffer.alloc(CONFIG.CHUNK_SIZE);
      const fd = fs.openSync(testFile, 'r');
      fs.readSync(fd, chunk, 0, CONFIG.CHUNK_SIZE, 0);
      fs.closeSync(fd);
    }

    const readTime = Date.now() - readStart;
    const memAfter = process.memoryUsage();

    log(`    Read time: ${readTime}ms`, 'green');
    log(`    Chunk size: ${formatSize(chunk.length)}`, 'cyan');
    log(`    Memory before: ${formatSize(memBefore.heapUsed)} heap, ${formatSize(memBefore.rss)} RSS`);
    log(`    Memory after:  ${formatSize(memAfter.heapUsed)} heap, ${formatSize(memAfter.rss)} RSS`);
    log(`    Memory delta:  ${formatSize(memAfter.heapUsed - memBefore.heapUsed)} heap, ${formatSize(memAfter.rss - memBefore.rss)} RSS`);

    // 4. 上传第一个分块
    log('\n[4] Uploading first chunk to R2...', 'yellow');

    const part = initResponse.files[0].parts[0];
    const uploadStart = Date.now();

    const uploadResponse = await fetch(part.uploadUrl, {
      method: 'PUT',
      body: chunk,
      headers: part.headers
    });

    const uploadTime = Date.now() - uploadStart;

    if (!uploadResponse.ok) {
      throw new Error(`Upload failed: ${uploadResponse.status}`);
    }

    const etag = uploadResponse.headers.get('ETag');
    const speed = (chunk.length / 1024 / 1024) / (uploadTime / 1000);

    log(`    Upload time: ${uploadTime}ms`, 'green');
    log(`    Upload speed: ${speed.toFixed(2)} MB/s`, speed < 5 ? 'yellow' : 'green');
    log(`    ETag: ${etag}`, 'cyan');

    // 5. 确认分块（详细测量）
    log('\n[5] Confirming chunk...', 'yellow');

    const confirmStart = Date.now();
    const confirmPayload = {
      uploadId: initResponse.uploadId,
      fileName: initResponse.files[0].name,
      chunkIndex: 0,
      partNumber: 1,
      etag
    };

    // 测量序列化时间
    const serializeStart = Date.now();
    const confirmBody = JSON.stringify(confirmPayload);
    const serializeTime = Date.now() - serializeStart;

    // 测量网络请求时间
    const networkStart = Date.now();
    const confirmResponse = await fetch(`${CONFIG.BASE_URL}/api/upload/chunk/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: confirmBody
    });
    const networkTime = Date.now() - networkStart;

    // 测量解析时间
    const parseStart = Date.now();
    const confirmResult = await confirmResponse.json();
    const parseTime = Date.now() - parseStart;

    const confirmTime = Date.now() - confirmStart;

    log(`    Confirm time: ${confirmTime}ms`, confirmTime > 1000 ? 'yellow' : 'green');
    log(`      - Serialize: ${serializeTime}ms`, 'cyan');
    log(`      - Network:   ${networkTime}ms`, networkTime > 800 ? 'yellow' : 'cyan');
    log(`      - Parse:     ${parseTime}ms`, 'cyan');
    log(`    Response:`, 'cyan');
    log(`      ${JSON.stringify(confirmResult)}`, 'cyan');

    return {
      fileSize,
      readMode,
      initTime,
      readTime,
      uploadTime,
      uploadSpeed: speed,
      confirmTime,
      confirmNetworkTime: networkTime,
      confirmSerializeTime: serializeTime,
      confirmParseTime: parseTime,
      memoryDelta: memAfter.heapUsed - memBefore.heapUsed,
      rssDelta: memAfter.rss - memBefore.rss
    };

  } finally {
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  }
}

async function main() {
  log('\n╔════════════════════════════════════════════════════════════════╗', 'magenta');
  log('║    FastFile First Chunk Upload Speed Comparison Test          ║', 'magenta');
  log('╚════════════════════════════════════════════════════════════════╝', 'magenta');

  const results = [];

  // 测试不同大小的文件（同步读取）
  for (const size of [10, 100, 500, 1000]) {
    const result = await testFirstChunk(size, 'sync');
    results.push(result);

    // 等待系统稳定
    await new Promise(r => setTimeout(r, 3000));
  }

  // 再用流式读取测试大文件
  log('\n\n' + '█'.repeat(70), 'magenta');
  log('Now testing with stream read...', 'magenta');
  log('█'.repeat(70), 'magenta');

  for (const size of [100, 500, 1000]) {
    const result = await testFirstChunk(size, 'stream');
    results.push(result);

    await new Promise(r => setTimeout(r, 3000));
  }

  // 汇总报告
  log('\n\n╔════════════════════════════════════════════════════════════════════════════════════════╗', 'cyan');
  log('║                                  SUMMARY REPORT                                        ║', 'cyan');
  log('╚════════════════════════════════════════════════════════════════════════════════════════╝', 'cyan');

  log('\n┌────────────┬───────────┬──────────┬──────────┬──────────────┬─────────────┬──────────────┐');
  log('│ File Size  │ Read Mode │ Init(ms) │ Read(ms) │ Upload Speed │ Confirm(ms) │ Memory Δ     │');
  log('├────────────┼───────────┼──────────┼──────────┼──────────────┼─────────────┼──────────────┤');

  for (const r of results) {
    const size = `${r.fileSize} MB`.padEnd(10);
    const mode = r.readMode.padEnd(9);
    const init = `${r.initTime}`.padEnd(8);
    const read = `${r.readTime}`.padEnd(8);
    const speed = `${r.uploadSpeed.toFixed(2)} MB/s`.padEnd(12);
    const confirm = `${r.confirmTime}`.padEnd(11);
    const mem = formatSize(r.memoryDelta).padEnd(12);

    const confirmColor = r.confirmTime > 1000 ? ' ⚠️' : '';
    log(`│ ${size} │ ${mode} │ ${init} │ ${read} │ ${speed} │ ${confirm}${confirmColor} │ ${mem} │`);
  }

  log('└────────────┴───────────┴──────────┴──────────┴──────────────┴─────────────┴──────────────┘');

  // Confirm 详细分析
  log('\n📋 Confirm API Breakdown:', 'cyan');
  log('┌────────────┬───────────┬──────────────┬──────────────┬──────────────┬──────────────┐');
  log('│ File Size  │ Read Mode │ Total (ms)   │ Serialize    │ Network      │ Parse        │');
  log('├────────────┼───────────┼──────────────┼──────────────┼──────────────┼──────────────┤');

  for (const r of results) {
    const size = `${r.fileSize} MB`.padEnd(10);
    const mode = r.readMode.padEnd(9);
    const total = `${r.confirmTime}`.padEnd(12);
    const serialize = `${r.confirmSerializeTime}`.padEnd(12);
    const network = `${r.confirmNetworkTime}`.padEnd(12);
    const parse = `${r.confirmParseTime}`.padEnd(12);

    log(`│ ${size} │ ${mode} │ ${total} │ ${serialize} │ ${network} │ ${parse} │`);
  }

  log('└────────────┴───────────┴──────────────┴──────────────┴──────────────┴──────────────┘');

  // 分析
  log('\n╔════════════════════════════════════════════════════════════════╗', 'yellow');
  log('║                           ANALYSIS                             ║', 'yellow');
  log('╚════════════════════════════════════════════════════════════════╝', 'yellow');

  const sync100 = results.find(r => r.fileSize === 100 && r.readMode === 'sync');
  const sync1000 = results.find(r => r.fileSize === 1000 && r.readMode === 'sync');
  const stream1000 = results.find(r => r.fileSize === 1000 && r.readMode === 'stream');

  const speedDrop = ((sync1000.uploadSpeed - sync100.uploadSpeed) / sync100.uploadSpeed * 100);

  log(`\n📊 Upload Speed Comparison (Sync Read):`, 'cyan');
  log(`   100MB:  ${sync100.uploadSpeed.toFixed(2)} MB/s`);
  log(`   1000MB: ${sync1000.uploadSpeed.toFixed(2)} MB/s`);
  log(`   Delta:  ${speedDrop.toFixed(2)}% ${speedDrop < 0 ? '(slower)' : '(faster)'}`, speedDrop < -10 ? 'yellow' : 'green');

  if (stream1000) {
    log(`\n📊 Stream Read vs Sync Read (1000MB):`, 'cyan');
    log(`   Sync:   ${sync1000.uploadSpeed.toFixed(2)} MB/s`);
    log(`   Stream: ${stream1000.uploadSpeed.toFixed(2)} MB/s`);
    const improvement = ((stream1000.uploadSpeed - sync1000.uploadSpeed) / sync1000.uploadSpeed * 100);
    log(`   Delta:  ${improvement.toFixed(2)}% ${improvement > 0 ? '(faster)' : '(slower)'}`, improvement > 10 ? 'green' : 'yellow');
  }

  // ⭐ 新增：Confirm 时间分析
  log(`\n⏱️  Confirm API Performance:`, 'cyan');
  log(`   100MB  (sync):   ${sync100.confirmTime}ms (network: ${sync100.confirmNetworkTime}ms)`);
  log(`   1000MB (sync):   ${sync1000.confirmTime}ms (network: ${sync1000.confirmNetworkTime}ms)`);

  const confirmTimeDiff = sync1000.confirmTime - sync100.confirmTime;
  const confirmRatio = sync1000.confirmTime / sync100.confirmTime;

  if (confirmTimeDiff > 500) {
    log(`   ⚠️  Confirm time difference: +${confirmTimeDiff}ms (${confirmRatio.toFixed(2)}x slower)`, 'yellow');

    // 分析瓶颈在哪里
    const networkRatio = sync1000.confirmNetworkTime / sync100.confirmNetworkTime;
    if (networkRatio > 2) {
      log(`   🔍 Network time increased ${networkRatio.toFixed(2)}x → Server-side processing bottleneck`, 'yellow');
    } else {
      log(`   🔍 Network time consistent → Not a server processing issue`, 'green');
    }

    if (stream1000 && stream1000.confirmTime < sync1000.confirmTime * 0.8) {
      log(`   💡 Stream read improves confirm time: ${stream1000.confirmTime}ms vs ${sync1000.confirmTime}ms`, 'green');
    }
  } else {
    log(`   ✅ Confirm time is consistent`, 'green');
  }

  if (stream1000) {
    log(`   1000MB (stream): ${stream1000.confirmTime}ms (network: ${stream1000.confirmNetworkTime}ms)`);
  }

  log(`\n💾 Memory Impact (Sync Read):`, 'cyan');
  log(`   100MB file:  ${formatSize(sync100.memoryDelta)} memory increase`);
  log(`   1000MB file: ${formatSize(sync1000.memoryDelta)} memory increase`);

  if (stream1000) {
    log(`   1000MB (stream): ${formatSize(stream1000.memoryDelta)} memory increase`);
  }

  log(`\n⏱️  Init Time Comparison:`, 'cyan');
  log(`   100MB:  ${sync100.initTime}ms (${Math.ceil(100 / 5)} parts)`);
  log(`   1000MB: ${sync1000.initTime}ms (${Math.ceil(1000 / 5)} parts)`);

  const initRatio = sync1000.initTime / sync100.initTime;
  const partsRatio = Math.ceil(1000 / 5) / Math.ceil(100 / 5);

  if (initRatio > partsRatio * 1.5) {
    log(`   ⚠️  Init time scales faster than parts count (${initRatio.toFixed(2)}x vs ${partsRatio}x expected)`, 'yellow');
    log(`   🔍 Server may have O(n²) or inefficient presigned URL generation`, 'yellow');
  } else if (sync1000.initTime > 5000) {
    log(`   ⚠️  Init time is high (${sync1000.initTime}ms) but scales linearly`, 'yellow');
    log(`   💡 Consider: Lazy-load presigned URLs or batch generation`, 'green');
  }

  log('\n💡 Root Cause Analysis:', 'yellow');

  // 综合分析
  const issues = [];

  if (Math.abs(speedDrop) > 20) {
    issues.push({
      severity: 'high',
      issue: `Upload speed drops ${Math.abs(speedDrop).toFixed(0)}% for large files`,
      cause: sync1000.memoryDelta > 500 * 1024 * 1024 ? 'Memory pressure' : 'Unknown',
      solution: sync1000.memoryDelta > 500 * 1024 * 1024 ? 'Use stream-based reading' : 'Further investigation needed'
    });
  }

  if (confirmTimeDiff > 500) {
    const networkIncrease = sync1000.confirmNetworkTime - sync100.confirmNetworkTime;
    issues.push({
      severity: networkIncrease > 400 ? 'high' : 'medium',
      issue: `Confirm API ${confirmTimeDiff}ms slower for large files`,
      cause: networkIncrease > 400 ? 'Server-side KV write bottleneck' : 'Client-side delay',
      solution: networkIncrease > 400 ? 'Optimize KV writes on server' : 'Check client-side GC'
    });
  }

  if (initRatio > partsRatio * 1.5) {
    issues.push({
      severity: 'medium',
      issue: `Init time scales O(n²) or worse`,
      cause: 'Inefficient presigned URL generation',
      solution: 'Optimize server-side URL generation or lazy-load'
    });
  }

  if (issues.length === 0) {
    log(`   ✅ No significant performance issues detected`, 'green');
    log(`   ✅ Upload performance is consistent across file sizes`, 'green');
  } else {
    log(`\n   Found ${issues.length} performance issue(s):\n`, 'yellow');

    issues.forEach((issue, i) => {
      const icon = issue.severity === 'high' ? '🔴' : '🟡';
      log(`   ${icon} Issue ${i + 1}: ${issue.issue}`, 'yellow');
      log(`      Cause:    ${issue.cause}`, 'cyan');
      log(`      Solution: ${issue.solution}`, 'green');
      log('');
    });
  }

  // 推荐操作
  log('\n🚀 Recommended Actions:', 'cyan');

  if (sync1000.memoryDelta > 500 * 1024 * 1024) {
    log(`   1. Switch to stream-based file reading (test-client-stream.js)`, 'green');
  }

  if (confirmTimeDiff > 500 && sync1000.confirmNetworkTime > 800) {
    log(`   2. Investigate server-side KV write performance`, 'green');
    log(`      - Check KV write latency in logs`, 'cyan');
    log(`      - Consider async KV writes (fire-and-forget)`, 'cyan');
  }

  if (sync1000.initTime > 5000) {
    log(`   3. Optimize presigned URL generation on server`, 'green');
    log(`      - Implement lazy-loading (generate on-demand)`, 'cyan');
    log(`      - Or parallelize URL generation`, 'cyan');
  }
}

if (require.main === module) {
  main().catch(console.error);
}
