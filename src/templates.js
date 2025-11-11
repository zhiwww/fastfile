/**
 * FastFile - HTML 页面模板
 * 包含上传页面和下载页面的HTML生成函数
 */

/**
 * 渲染上传页面（R2 Multipart Upload版本）
 */
export async function serveUploadPage(CONFIG) {
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
      transition: all 0.3s;
    }

    input[type="text"]:focus {
      outline: none;
      border-color: #667eea;
    }

    input[type="text"]:disabled {
      background: #f8f9ff;
      border-color: #667eea;
      color: #667eea;
      font-weight: 600;
      cursor: not-allowed;
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
      display: inline-block;
      animation: spinner-rotate 1s linear infinite;
    }

    @keyframes spinner-rotate {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
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

    .url-container {
      margin-top: 15px;
      padding: 12px;
      background: #f8f9ff;
      border-radius: 8px;
    }

    .url-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 15px;
    }

    .url-text {
      flex: 1;
      font-family: 'Monaco', 'Courier New', monospace;
      font-size: 13px;
      color: #667eea;
      word-break: break-all;
      padding: 8px;
      background: white;
      border-radius: 4px;
    }

    .copy-btn {
      flex-shrink: 0;
      padding: 8px 12px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      transition: all 0.2s;
      white-space: nowrap;
    }

    .copy-btn:hover {
      background: #5568d3;
    }

    .copy-btn.copied {
      background: #28a745;
    }

    .password-reminder {
      padding: 10px;
      background: #fff3cd;
      border: 2px solid #ffc107;
      border-radius: 6px;
      text-align: center;
      font-size: 14px;
      color: #856404;
    }

    .password-value {
      font-size: 32px;
      font-weight: bold;
      color: #d63384;
      font-family: 'Monaco', 'Courier New', monospace;
      margin: 10px 0;
      letter-spacing: 4px;
      background: linear-gradient(135deg, #ffeaa7 0%, #fdcb6e 100%);
      padding: 15px 25px;
      border-radius: 10px;
      box-shadow: 0 4px 15px rgba(214, 51, 132, 0.2);
      cursor: pointer;
      transition: all 0.3s ease;
      display: inline-block;
      user-select: none;
      position: relative;
    }

    .password-value:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(214, 51, 132, 0.3);
      background: linear-gradient(135deg, #fdcb6e 0%, #ffeaa7 100%);
    }

    .password-value:active {
      transform: translateY(0);
    }

    .password-value::after {
      content: '点击复制';
      position: absolute;
      bottom: -20px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 11px;
      color: #856404;
      opacity: 0;
      transition: opacity 0.3s ease;
      white-space: nowrap;
    }

    .password-value:hover::after {
      opacity: 1;
    }

    .btn-next-upload {
      width: 100%;
      padding: 12px;
      margin-top: 15px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 16px;
      font-weight: 500;
      transition: all 0.3s;
    }

    .btn-next-upload:hover {
      transform: translateY(-2px);
      box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
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
    let currentPassword = '';  // 保存当前上传的密码

    // 配置常量 - 从后端同步
    const CHUNK_SIZE = ${CONFIG.CHUNK_SIZE};
    const MAX_CONCURRENT = ${CONFIG.MAX_CONCURRENT};
    const MAX_RETRY_ATTEMPTS = ${CONFIG.MAX_RETRY_ATTEMPTS};
    const RETRY_DELAY_BASE = ${CONFIG.RETRY_DELAY_BASE};
    const REQUEST_TIMEOUT = ${CONFIG.REQUEST_TIMEOUT};

    /**
     * 判断错误是否可重试
     */
    function isRetryableError(error, response) {
      // 可重试的HTTP状态码
      const retryableStatusCodes = [408, 429, 500, 502, 503, 504, 599];

      if (response && retryableStatusCodes.includes(response.status)) {
        return true;
      }

      // 网络错误（扩展）
      const message = (error.message || String(error)).toLowerCase();
      const retryableErrorPatterns = [
        'network',
        'timeout',
        'timed out',
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
        'protocol error',  // HTTP/2协议错误
        'err_http2',       // ERR_HTTP2错误
      ];

      for (const pattern of retryableErrorPatterns) {
        if (message.includes(pattern)) {
          return true;
        }
      }

      return false;
    }

    /**
     * 带超时的fetch请求
     */
    async function fetchWithTimeout(url, options = {}, timeout = REQUEST_TIMEOUT) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(url, {
          ...options,
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response;
      } catch (error) {
        clearTimeout(timeoutId);
        // 如果是AbortError，转换为更友好的超时错误
        if (error.name === 'AbortError') {
          const timeoutError = new Error(\`请求超时 (\${timeout}ms)\`);
          timeoutError.name = 'TimeoutError';
          throw timeoutError;
        }
        throw error;
      }
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
      progressBar.textContent = '';  // 确保进度条内部不显示任何文本
      progressPhase.innerHTML = phase;  // 使用innerHTML以支持HTML标签
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

      // 恢复密码输入和重新生成按钮
      passwordInput.disabled = false;
      regenerateBtn.disabled = false;
      regenerateBtn.style.opacity = '1';
      regenerateBtn.style.cursor = 'pointer';
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
      const fullUrl = window.location.origin + downloadUrl;

      showResult(\`
        <div class="password-reminder">
          <div>⚠️ 下载时需要输入下面的密码</div>
          <div class="password-value" onclick="copyToClipboard('\${currentPassword}', this)" title="点击复制密码">
            \${currentPassword}
          </div>
          <div style="font-size: 12px; color: #856404; margin-top: 25px;">点击复制此密码</div>
        </div>
        <div class="url-container">
          <div class="url-row">
            <div class="url-text">\${fullUrl}</div>
            <button class="copy-btn" onclick="copyToClipboard('\${fullUrl}', this)">
              📋 复制下载地址
            </button>
          </div>
        </div>
        <button class="btn-next-upload" onclick="location.reload()">
          📤 继续上传其他文件
        </button>
      \`, 'success');
    }

    // 复制到剪贴板
    window.copyToClipboard = async function(text, element) {
      try {
        await navigator.clipboard.writeText(text);
        const originalText = element.textContent;
        const isPasswordDiv = element.classList.contains('password-value');

        if (isPasswordDiv) {
          // 对于密码 div，显示临时提示而不改变密码显示
          const originalContent = element.innerHTML;
          element.innerHTML = '✓ 已复制！';
          element.style.background = 'linear-gradient(135deg, #a8e6cf 0%, #56cc9d 100%)';

          setTimeout(() => {
            element.innerHTML = originalContent;
            element.style.background = '';
          }, 1500);
        } else {
          // 对于按钮，改变文本
          element.textContent = '✓ 已复制';
          element.classList.add('copied');

          setTimeout(() => {
            element.textContent = originalText;
            element.classList.remove('copied');
          }, 2000);
        }
      } catch (err) {
        console.error('复制失败:', err);
        // 降级方案
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        document.body.appendChild(textArea);
        textArea.select();
        try {
          document.execCommand('copy');
          const isPasswordDiv = element.classList.contains('password-value');

          if (isPasswordDiv) {
            const originalContent = element.innerHTML;
            element.innerHTML = '✓ 已复制！';
            element.style.background = 'linear-gradient(135deg, #a8e6cf 0%, #56cc9d 100%)';

            setTimeout(() => {
              element.innerHTML = originalContent;
              element.style.background = '';
            }, 1500);
          } else {
            element.textContent = '✓ 已复制';
            element.classList.add('copied');
            setTimeout(() => {
              element.textContent = '📋 复制';
              element.classList.remove('copied');
            }, 2000);
          }
        } catch (err2) {
          alert('复制失败，请手动复制');
        }
        document.body.removeChild(textArea);
      }
    };

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

      // 保存密码用于成功后显示
      currentPassword = password;

      // 开始上传
      isUploading = true;
      uploadAborted = false;
      uploadBtn.style.display = 'none';
      progressContainer.classList.add('show');
      warningBanner.classList.add('show');
      cancelBtn.classList.add('show');
      result.classList.remove('show');

      // 隐藏上传区域、已选文件列表
      uploadArea.style.display = 'none';
      selectedFiles.style.display = 'none';

      // 禁用密码输入和重新生成按钮
      passwordInput.disabled = true;
      regenerateBtn.disabled = true;
      regenerateBtn.style.opacity = '0.5';
      regenerateBtn.style.cursor = 'not-allowed';

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

      const initResponse = await fetchWithTimeout('/api/upload/init', {
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

        // 🔧 修复：不再预先切片所有chunks，而是在上传时即时切片
        // 原因：预先切片会创建多个Blob引用，可能导致内存问题或文件句柄问题
        // 改为只存储chunk索引，在上传时再切片
        const chunkIndices = [];
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
          chunkIndices.push(chunkIndex);
        }

        // 并发上传分块
        let uploadedChunks = 0;
        const uploadQueue = [...chunkIndices];

        const uploadWorkers = [];
        for (let w = 0; w < MAX_CONCURRENT; w++) {
          uploadWorkers.push((async () => {
            while (uploadQueue.length > 0) {
              if (uploadAborted) return;

              const chunkIndex = uploadQueue.shift();
              if (chunkIndex === undefined) break;

              // 在上传前立即切片，避免持有多个Blob引用
              const start = chunkIndex * CHUNK_SIZE;
              const end = Math.min(start + CHUNK_SIZE, file.size);
              const chunk = file.slice(start, end);
              const chunkSize = end - start;

              const formData = new FormData();
              formData.append('uploadId', uploadId);
              formData.append('fileName', file.name);
              formData.append('chunkIndex', chunkIndex);
              formData.append('chunk', chunk);

              // 使用重试机制上传分块
              const chunkStartTime = Date.now();
              const chunkData = await retryWithBackoff(
                async () => {
                  const chunkResponse = await fetchWithTimeout('/api/upload/chunk', {
                    method: 'POST',
                    body: formData
                  });

                  if (!chunkResponse.ok) {
                    const error = new Error(\`分块上传失败: \${file.name} - chunk \${chunkIndex}\`);
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
                \`Upload chunk \${chunkIndex + 1} of \${file.name}\`
              );

              const chunkDuration = Date.now() - chunkStartTime;
              const chunkSpeed = (chunkSize / 1024 / 1024) / (chunkDuration / 1000); // MB/s

              // 如果单个chunk上传时间过长，记录警告
              if (chunkDuration > 30000) {
                console.warn(\`⚠️ Slow chunk upload detected: chunk \${chunkIndex} took \${(chunkDuration / 1000).toFixed(1)}s (\${chunkSpeed.toFixed(2)} MB/s)\`);
              }

              uploadedChunks++;
              uploadedBytes += chunkSize;

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

      const completeResponse = await fetchWithTimeout('/api/upload/complete', {
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
      updateProgress(90, '<span class="spinner">⏳</span> 压缩中（第2阶段，共2阶段）', '正在服务器端打包文件，可能需要几分钟，请耐心等待...', '', '');

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
            updateProgress(100, '✓ 压缩完成！', '', '', '');

            setTimeout(() => {
              showSuccessResult(data);
              finishUpload();
            }, 500);
          } else if (data.status === 'failed') {
            // 🔧 修复：直接在这里处理失败状态，而不是throw error
            // 因为在setInterval回调中throw error不会被外层catch捕获
            clearInterval(statusPollInterval);
            console.error('Compression failed:', data.error);
            showResult('压缩失败: ' + (data.error || '未知错误'), 'error');
            resetUpload();
          } else {
            // 压缩中，更新进度
            const compressPercent = 90 + (data.progress || 0) * 0.1; // 90%-100%

            let details = '';
            if (data.currentFile) {
              details = \`正在处理: \${data.currentFile}\`;
            } else if (data.processedCount !== undefined) {
              details = \`已处理 \${data.processedCount}/\${data.totalCount} 个文件\`;
            }

            updateProgress(
              compressPercent,
              '<span class="spinner">⏳</span> 压缩中（第2阶段，共2阶段）',
              details,
              '',
              '大文件压缩需要时间，请勿关闭页面'
            );
          }
        } catch (error) {
          clearInterval(statusPollInterval);
          if (!uploadAborted) {
            console.error('Status polling error:', error);
            showResult('查询状态失败: ' + error.message, 'error');
            resetUpload();
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
 * @param {string} fileId - 文件ID
 * @param {object} metadata - 文件元数据（由路由层提供）
 * @returns {Response} HTML页面响应
 */
export async function serveDownloadPage(fileId, metadata) {
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
      <p><strong>上传时间：</strong><span id="uploadTime">${formatDate(metadata.uploadedAt)}</span></p>
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
export function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 辅助函数：格式化日期
export function formatDate(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
