/**
 * 测试fflate压缩性能
 */

import { zipSync } from 'fflate';

// 生成测试数据
function generateTestData(sizeMB) {
  const sizeBytes = sizeMB * 1024 * 1024;
  const buffer = new Uint8Array(sizeBytes);

  // 填充随机数据（更真实的压缩场景）
  for (let i = 0; i < sizeBytes; i++) {
    buffer[i] = Math.floor(Math.random() * 256);
  }

  return buffer;
}

// 测试压缩性能
function testCompression(sizeMB, level = 6) {
  console.log(`\n测试 ${sizeMB}MB 数据，压缩级别 ${level}...`);

  const testData = generateTestData(sizeMB);
  console.log(`生成了 ${(testData.length / 1024 / 1024).toFixed(2)} MB 测试数据`);

  const filesToZip = {
    'test-file.bin': testData
  };

  const startTime = Date.now();
  const startCPU = process.cpuUsage();

  const compressed = zipSync(filesToZip, { level });

  const endTime = Date.now();
  const endCPU = process.cpuUsage(startCPU);

  const elapsedMs = endTime - startTime;
  const cpuMs = (endCPU.user + endCPU.system) / 1000;
  const speedMBps = (testData.length / 1024 / 1024) / (elapsedMs / 1000);
  const cpuSpeedMBps = (testData.length / 1024 / 1024) / (cpuMs / 1000);
  const compressionRatio = ((1 - compressed.length / testData.length) * 100).toFixed(2);

  console.log(`原始大小: ${(testData.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`压缩后大小: ${(compressed.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`压缩率: ${compressionRatio}%`);
  console.log(`墙钟时间: ${elapsedMs}ms (${elapsedMs / 1000}秒)`);
  console.log(`CPU时间: ${cpuMs.toFixed(2)}ms (${(cpuMs / 1000).toFixed(2)}秒)`);
  console.log(`压缩速度 (墙钟): ${speedMBps.toFixed(2)} MB/s`);
  console.log(`压缩速度 (CPU): ${cpuSpeedMBps.toFixed(2)} MB/s`);

  return {
    sizeMB,
    elapsedMs,
    cpuMs,
    speedMBps,
    cpuSpeedMBps,
    compressionRatio
  };
}

// 运行多个测试
console.log('='.repeat(60));
console.log('fflate 压缩性能测试');
console.log('='.repeat(60));

const testSizes = [1, 10, 50, 100];
const results = [];

for (const size of testSizes) {
  try {
    const result = testCompression(size);
    results.push(result);
  } catch (error) {
    console.error(`测试 ${size}MB 失败:`, error.message);
    break;
  }
}

// 估算10GB压缩时间
console.log('\n' + '='.repeat(60));
console.log('10GB 文件压缩时间估算');
console.log('='.repeat(60));

if (results.length > 0) {
  // 使用最大测试结果来估算
  const largestTest = results[results.length - 1];
  const avgCpuSpeed = largestTest.cpuSpeedMBps;

  const gb10InMB = 10 * 1024;
  const estimatedCpuTimeSeconds = gb10InMB / avgCpuSpeed;
  const estimatedCpuTimeMinutes = estimatedCpuTimeSeconds / 60;

  console.log(`\n基于 ${largestTest.sizeMB}MB 测试结果:`);
  console.log(`平均CPU压缩速度: ${avgCpuSpeed.toFixed(2)} MB/s`);
  console.log(`\n10GB (10240MB) 文件估算:`);
  console.log(`  预计CPU时间: ${estimatedCpuTimeSeconds.toFixed(2)} 秒 (${estimatedCpuTimeMinutes.toFixed(2)} 分钟)`);
  console.log(`  预计墙钟时间: ${(estimatedCpuTimeSeconds * 1.1).toFixed(2)} 秒 (${(estimatedCpuTimeMinutes * 1.1).toFixed(2)} 分钟)`);

  console.log('\n⚠️  Workers CPU 限制分析:');
  console.log(`  默认限制: 30秒 (30,000ms)`);
  console.log(`  最大限制: 5分钟 (300,000ms = 300秒)`);

  if (estimatedCpuTimeSeconds <= 30) {
    console.log(`  ✅ 10GB压缩在默认限制内`);
  } else if (estimatedCpuTimeSeconds <= 300) {
    console.log(`  ⚠️  10GB压缩需要增加CPU限制配置`);
    console.log(`      建议在 wrangler.toml 中设置: cpu_ms = ${Math.ceil(estimatedCpuTimeSeconds * 1000)}`);
  } else {
    console.log(`  ❌ 10GB压缩超出Workers最大CPU限制`);
    console.log(`      建议方案:`);
    console.log(`      1. 使用流式压缩分块处理`);
    console.log(`      2. 使用Cloudflare Durable Objects`);
    console.log(`      3. 降低压缩级别 (当前: 6, 可降至 1-3)`);
    console.log(`      4. 限制单次上传文件大小`);
  }

  // 估算不同压缩级别的影响
  console.log('\n📊 不同压缩级别的估算 (基于典型经验值):');
  const levels = [
    { level: 0, speedFactor: 10, desc: '无压缩(仅打包)' },
    { level: 1, speedFactor: 3, desc: '最快压缩' },
    { level: 3, speedFactor: 2, desc: '快速压缩' },
    { level: 6, speedFactor: 1, desc: '默认压缩' },
    { level: 9, speedFactor: 0.5, desc: '最大压缩' }
  ];

  levels.forEach(({ level, speedFactor, desc }) => {
    const adjustedSpeed = avgCpuSpeed * speedFactor;
    const adjustedTime = gb10InMB / adjustedSpeed;
    const adjustedMinutes = adjustedTime / 60;
    const withinLimit = adjustedTime <= 300 ? '✅' : '❌';
    console.log(`  级别 ${level} (${desc}): ${adjustedTime.toFixed(0)}秒 (${adjustedMinutes.toFixed(1)}分钟) ${withinLimit}`);
  });
}

console.log('\n' + '='.repeat(60));
