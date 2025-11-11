/**
 * 测试日志系统
 */
import {
  createLogger,
  generateRequestId,
  MetricsTracker,
  RequestTracker,
  UploadSessionTracker
} from './src/logger.js';

console.log('🧪 开始测试日志系统...\n');

// 模拟环境变量
const mockEnv = {
  LOG_LEVEL: 'INFO',
  ENVIRONMENT: 'development',
  VERSION: '1.0.0'
};

// 1. 测试基础日志
console.log('📝 测试 1: 基础日志功能');
const logger = createLogger(mockEnv);

logger.debug('This is a debug message', { test: 'debug' });
logger.info('This is an info message', { test: 'info' });
logger.warn('This is a warning message', { test: 'warn' });
logger.error('This is an error message', { test: 'error' });

// 测试错误对象
const testError = new Error('Test error object');
logger.error('Error with stack trace', { error: testError });

console.log('\n✅ 基础日志测试完成\n');

// 2. 测试子日志器
console.log('📝 测试 2: 子日志器');
const childLogger = logger.child({ module: 'test-module', requestId: 'req-123' });
childLogger.info('Child logger message');
console.log('\n✅ 子日志器测试完成\n');

// 3. 测试指标追踪
console.log('📝 测试 3: 指标追踪');
const metrics = new MetricsTracker();
metrics.increment('test.counter', 1);
metrics.increment('test.counter', 5);
metrics.gauge('test.gauge', 100);
metrics.timing('test.duration', 1234);
metrics.increment('test.tagged', 1, { status: '200' });

console.log('指标数据:', JSON.stringify(metrics.getMetrics(), null, 2));
console.log('\n✅ 指标追踪测试完成\n');

// 4. 测试请求追踪
console.log('📝 测试 4: 请求追踪');
const requestId = generateRequestId();
const requestMetrics = new MetricsTracker();
const requestTracker = new RequestTracker(requestId, logger, requestMetrics);

requestTracker.event('request.start', { method: 'POST', path: '/api/test' });
requestTracker.event('processing', { step: 'validation' });
requestTracker.event('processing', { step: 'execution' });
requestTracker.finish(200, { size: 1024 });

console.log('请求指标:', JSON.stringify(requestMetrics.getMetrics(), null, 2));
console.log('\n✅ 请求追踪测试完成\n');

// 5. 测试上传会话追踪
console.log('📝 测试 5: 上传会话追踪');
const uploadId = 'upload-test-123';
const uploadMetrics = new MetricsTracker();
const uploadTracker = new UploadSessionTracker(uploadId, logger, uploadMetrics);

uploadTracker.initUpload(3, 30 * 1024 * 1024); // 3 files, 30MB total
uploadTracker.chunks.total = 10;

// 模拟chunk上传
uploadTracker.chunkSuccess(0, 10485760); // 10MB
uploadTracker.chunkSuccess(1, 10485760, 1); // 第二个chunk重试了1次
uploadTracker.chunkSuccess(2, 10485760);
uploadTracker.chunkFailure(3, new Error('Network error'), 2);
uploadTracker.chunkSuccess(3, 10485760, 2); // 重试成功

uploadTracker.complete(true);

console.log('上传指标:', JSON.stringify(uploadMetrics.getMetrics(), null, 2));
console.log('\n✅ 上传会话追踪测试完成\n');

// 6. 测试指标flush
console.log('📝 测试 6: 指标输出到日志');
metrics.flush(logger);
console.log('\n✅ 指标flush测试完成\n');

console.log('🎉 所有测试完成！');
