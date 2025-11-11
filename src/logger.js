/**
 * 结构化日志系统
 * 支持 Cloudflare Workers 日志和监控
 */

// 日志级别
const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4
};

// 日志级别名称映射
const LogLevelNames = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR',
  [LogLevel.FATAL]: 'FATAL'
};

/**
 * 结构化日志类
 */
class Logger {
  constructor(context = {}, minLevel = LogLevel.INFO) {
    this.context = context;
    this.minLevel = minLevel;
  }

  /**
   * 创建子日志器，继承上下文
   */
  child(additionalContext) {
    return new Logger(
      { ...this.context, ...additionalContext },
      this.minLevel
    );
  }

  /**
   * 格式化日志消息
   */
  formatLog(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level: LogLevelNames[level],
      message,
      ...this.context,
      ...data
    };

    // 如果有错误对象，添加堆栈信息
    if (data.error instanceof Error) {
      logEntry.error = {
        name: data.error.name,
        message: data.error.message,
        stack: data.error.stack
      };
    }

    return logEntry;
  }

  /**
   * 输出日志
   */
  log(level, message, data = {}) {
    if (level < this.minLevel) {
      return;
    }

    const logEntry = this.formatLog(level, message, data);
    const jsonLog = JSON.stringify(logEntry);

    // 根据级别选择输出方法
    switch (level) {
      case LogLevel.DEBUG:
      case LogLevel.INFO:
        console.log(jsonLog);
        break;
      case LogLevel.WARN:
        console.warn(jsonLog);
        break;
      case LogLevel.ERROR:
      case LogLevel.FATAL:
        console.error(jsonLog);
        break;
    }
  }

  debug(message, data = {}) {
    this.log(LogLevel.DEBUG, message, data);
  }

  info(message, data = {}) {
    this.log(LogLevel.INFO, message, data);
  }

  warn(message, data = {}) {
    this.log(LogLevel.WARN, message, data);
  }

  error(message, data = {}) {
    this.log(LogLevel.ERROR, message, data);
  }

  fatal(message, data = {}) {
    this.log(LogLevel.FATAL, message, data);
  }
}

/**
 * 性能指标追踪器
 */
class MetricsTracker {
  constructor() {
    this.metrics = new Map();
  }

  /**
   * 记录计数器指标
   */
  increment(name, value = 1, tags = {}) {
    const key = this.getMetricKey(name, tags);
    const current = this.metrics.get(key) || { name, tags, value: 0, type: 'counter' };
    current.value += value;
    this.metrics.set(key, current);
  }

  /**
   * 记录gauge指标
   */
  gauge(name, value, tags = {}) {
    const key = this.getMetricKey(name, tags);
    this.metrics.set(key, { name, tags, value, type: 'gauge' });
  }

  /**
   * 记录时间指标
   */
  timing(name, duration, tags = {}) {
    const key = this.getMetricKey(name, tags);
    this.metrics.set(key, { name, tags, value: duration, type: 'timing', unit: 'ms' });
  }

  /**
   * 获取指标键
   */
  getMetricKey(name, tags) {
    const tagStr = Object.entries(tags)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(',');
    return `${name}{${tagStr}}`;
  }

  /**
   * 获取所有指标
   */
  getMetrics() {
    return Array.from(this.metrics.values());
  }

  /**
   * 清空指标
   */
  clear() {
    this.metrics.clear();
  }

  /**
   * 输出指标到日志
   */
  flush(logger) {
    const metrics = this.getMetrics();
    if (metrics.length > 0) {
      logger.info('Metrics report', { metrics });
    }
  }
}

/**
 * 请求追踪器
 */
class RequestTracker {
  constructor(requestId, logger, metrics) {
    this.requestId = requestId;
    this.logger = logger.child({ requestId });
    this.metrics = metrics;
    this.startTime = Date.now();
    this.events = [];
  }

  /**
   * 记录事件
   */
  event(name, data = {}) {
    const timestamp = Date.now();
    const elapsed = timestamp - this.startTime;
    this.events.push({ name, timestamp, elapsed, data });
    this.logger.debug(`Event: ${name}`, { elapsed, ...data });
  }

  /**
   * 记录错误
   */
  error(error, context = {}) {
    this.logger.error('Request error', { error, ...context });
    this.metrics.increment('request.errors', 1, { type: error.name });
  }

  /**
   * 完成请求追踪
   */
  finish(statusCode, context = {}) {
    const duration = Date.now() - this.startTime;
    this.metrics.timing('request.duration', duration, { status: statusCode });
    this.metrics.increment('request.total', 1, { status: statusCode });

    this.logger.info('Request completed', {
      statusCode,
      duration,
      events: this.events.length,
      ...context
    });
  }
}

/**
 * 上传会话追踪器
 */
class UploadSessionTracker {
  constructor(uploadId, logger, metrics) {
    this.uploadId = uploadId;
    this.logger = logger.child({ uploadId });
    this.metrics = metrics;
    this.startTime = Date.now();
    this.chunks = {
      total: 0,
      uploaded: 0,
      failed: 0,
      retried: 0
    };
  }

  /**
   * 初始化上传
   */
  initUpload(filesCount, totalSize) {
    this.logger.info('Upload initialized', { filesCount, totalSize });
    this.metrics.increment('upload.init', 1);
  }

  /**
   * 分块上传成功
   */
  chunkSuccess(chunkIndex, size, retryCount = 0) {
    this.chunks.uploaded++;
    if (retryCount > 0) {
      this.chunks.retried++;
      this.metrics.increment('chunk.retried', 1);
    }

    this.metrics.increment('chunk.success', 1);
    this.metrics.gauge('chunk.size', size);

    this.logger.debug('Chunk uploaded', {
      chunkIndex,
      size,
      retryCount,
      progress: `${this.chunks.uploaded}/${this.chunks.total}`
    });
  }

  /**
   * 分块上传失败
   */
  chunkFailure(chunkIndex, error, retryCount = 0) {
    this.chunks.failed++;
    this.metrics.increment('chunk.failed', 1, { error: error.name });

    this.logger.error('Chunk upload failed', {
      chunkIndex,
      error,
      retryCount,
      progress: `${this.chunks.uploaded}/${this.chunks.total}`
    });
  }

  /**
   * 上传完成
   */
  complete(success = true) {
    const duration = Date.now() - this.startTime;
    this.metrics.timing('upload.duration', duration, { success });
    this.metrics.increment('upload.complete', 1, { success });

    this.logger.info('Upload completed', {
      success,
      duration,
      chunks: this.chunks,
      retryRate: this.chunks.total > 0
        ? (this.chunks.retried / this.chunks.total * 100).toFixed(2) + '%'
        : '0%'
    });
  }
}

/**
 * 创建根日志器
 */
function createLogger(env = {}) {
  // 从环境变量获取日志级别
  const logLevel = env.LOG_LEVEL || 'INFO';
  const minLevel = LogLevel[logLevel] || LogLevel.INFO;

  return new Logger(
    {
      environment: env.ENVIRONMENT || 'production',
      version: env.VERSION || 'unknown'
    },
    minLevel
  );
}

/**
 * 生成请求ID
 */
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

export {
  Logger,
  LogLevel,
  MetricsTracker,
  RequestTracker,
  UploadSessionTracker,
  createLogger,
  generateRequestId
};
