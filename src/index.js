/**
 * FastFile - Cloudflare Workers 主入口
 * 大文件中转应用
 */

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
        if (path === '/api/upload' && request.method === 'POST') {
          return await handleUpload(request, env);
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
 * 处理文件上传
 */
async function handleUpload(request, env) {
  try {
    const formData = await request.formData();
    const file = formData.get('files'); // 客户端已打包为单个文件
    const password = formData.get('password');

    // 验证密码
    if (!password || !isValidPassword(password)) {
      return errorResponse('密码必须是4位数字');
    }

    // 验证文件
    if (!file) {
      return errorResponse('请选择要上传的文件');
    }

    // 生成文件ID
    const fileId = generateFileId();
    const expiryTime = getExpiryTime();
    const hashedPwd = await hashPassword(password);

    // 获取文件信息
    const fileBuffer = await file.arrayBuffer();
    const fileSize = fileBuffer.byteLength;
    const fileName = file.name;

    // 检查文件大小（10GB限制）
    if (fileSize > 10 * 1024 * 1024 * 1024) {
      return errorResponse('文件大小超过10GB限制');
    }

    // 存储文件到R2
    await env.FILE_STORAGE.put(fileId, fileBuffer);

    // 保存元数据
    const metadata = {
      fileId,
      password: hashedPwd,
      expiryTime,
      createdAt: Date.now(),
      fileName: fileName,
      fileSize,
    };

    await env.FILE_META.put(fileId, JSON.stringify(metadata));

    // 返回下载链接
    return jsonResponse({
      success: true,
      fileId,
      downloadUrl: `/d/${fileId}`,
      expiryTime,
    });

  } catch (error) {
    console.error('Upload error:', error);
    return errorResponse('上传失败: ' + error.message, 500);
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

    // 使用哈希后的密码生成令牌，这样下载时也能验证
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
      return errorResponse('文件不存在或已过期', 404);
    }

    const metadata = JSON.parse(metadataStr);

    // 检查是否过期
    if (isExpired(metadata.expiryTime)) {
      await deleteFile(fileId, env);
      return errorResponse('文件已过期', 410);
    }

    // 验证下载令牌
    const expectedToken = await generateDownloadToken(fileId, metadata.password);
    if (token !== expectedToken) {
      return errorResponse('无效的下载令牌', 401);
    }

    // 从R2获取文件
    const fileObject = await env.FILE_STORAGE.get(fileId);

    if (!fileObject) {
      return errorResponse('文件不存在', 404);
    }

    return new Response(fileObject.body, {
      headers: {
        'Content-Type': 'application/octet-stream',
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
async function generateDownloadToken(fileId, password) {
  const data = `${fileId}:${password}`;
  const hash = await hashPassword(data);
  return hash.substring(0, 16);
}

/**
 * 删除文件
 */
async function deleteFile(fileId, env) {
  try {
    // 删除元数据
    await env.FILE_META.delete(fileId);

    // 删除R2中的文件
    await env.FILE_STORAGE.delete(fileId);
  } catch (error) {
    console.error('Delete file error:', error);
  }
}

/**
 * 清理过期文件（定时任务）
 */
async function cleanupExpiredFiles(env) {
  try {
    // 列出所有文件元数据
    const list = await env.FILE_META.list();

    for (const key of list.keys) {
      const metadataStr = await env.FILE_META.get(key.name);

      if (metadataStr) {
        const metadata = JSON.parse(metadataStr);

        if (isExpired(metadata.expiryTime)) {
          await deleteFile(key.name, env);
          console.log(`Deleted expired file: ${key.name}`);
        }
      }
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

/**
 * 返回上传页面
 */
async function serveUploadPage() {
  // 这里需要读取public/index.html
  // 在Workers中，我们需要将HTML内联或使用Assets
  // 暂时返回简单的HTML
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FastFile - 大文件中转</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; padding: 20px; min-height: 100vh; }
    .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; padding: 40px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    h1 { color: #333; margin-bottom: 30px; text-align: center; font-size: 28px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 8px; color: #555; font-weight: 500; font-size: 15px; }
    input[type="file"] { width: 100%; padding: 12px; border: 2px dashed #ddd; border-radius: 8px; cursor: pointer; font-size: 14px; }
    input[type="file"]::-webkit-file-upload-button { padding: 8px 16px; border: none; background: #007bff; color: white; border-radius: 6px; cursor: pointer; font-size: 14px; }
    .password-group { display: flex; gap: 10px; align-items: center; }
    input[type="text"] { flex: 1; padding: 14px; border: 1px solid #ddd; border-radius: 8px; font-size: 18px; letter-spacing: 2px; text-align: center; font-weight: bold; min-height: 48px; }
    input[type="text"]:focus { outline: none; border-color: #007bff; box-shadow: 0 0 0 3px rgba(0,123,255,0.1); }
    .generate-btn { padding: 14px 20px; background: #28a745; color: white; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; transition: background 0.3s; white-space: nowrap; min-height: 48px; }
    .generate-btn:hover { background: #218838; }
    .generate-btn:active { transform: scale(0.98); }
    button { width: 100%; padding: 16px; background: #007bff; color: white; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; transition: background 0.3s; min-height: 48px; font-weight: 500; }
    button:hover { background: #0056b3; }
    button:active { transform: scale(0.98); }
    button:disabled { background: #ccc; cursor: not-allowed; }
    small { font-size: 13px; line-height: 1.4; }
    .message { margin-top: 20px; padding: 16px; border-radius: 8px; display: none; line-height: 1.6; font-size: 14px; }
    .message.success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
    .message.error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
    .download-link { margin-top: 10px; word-break: break-all; }
    .download-link a { color: #007bff; text-decoration: none; }
    .progress { margin-top: 20px; display: none; }
    .progress-bar { width: 100%; height: 36px; background: #f0f0f0; border-radius: 18px; overflow: hidden; }
    .progress-fill { height: 100%; background: #007bff; transition: width 0.3s; text-align: center; color: white; line-height: 36px; font-weight: 500; }

    /* 平板电脑适配 */
    @media (max-width: 768px) {
      body { padding: 15px; }
      .container { padding: 30px 25px; }
      h1 { font-size: 24px; margin-bottom: 25px; }
      label { font-size: 14px; }
    }

    /* 手机适配 */
    @media (max-width: 480px) {
      body { padding: 10px; }
      .container { padding: 20px 15px; border-radius: 8px; }
      h1 { font-size: 20px; margin-bottom: 20px; }
      .form-group { margin-bottom: 16px; }
      label { font-size: 13px; margin-bottom: 6px; }
      input[type="file"] { padding: 10px; font-size: 13px; }
      input[type="file"]::-webkit-file-upload-button { padding: 6px 12px; font-size: 13px; }
      .password-group { gap: 8px; }
      input[type="text"] { padding: 12px 8px; font-size: 16px; letter-spacing: 1px; min-height: 44px; }
      .generate-btn { padding: 12px 12px; font-size: 13px; min-height: 44px; }
      button { padding: 14px; font-size: 15px; min-height: 44px; }
      small { font-size: 12px; }
      .message { padding: 12px; font-size: 13px; }
      .progress-bar { height: 32px; }
      .progress-fill { line-height: 32px; font-size: 13px; }
    }

    /* 小屏幕手机适配 */
    @media (max-width: 360px) {
      .container { padding: 15px 10px; }
      h1 { font-size: 18px; }
      .password-group { flex-direction: column; gap: 8px; }
      .generate-btn { width: 100%; }
    }
  </style>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
</head>
<body>
  <div class="container">
    <h1>📦 FastFile 大文件中转</h1>

    <form id="uploadForm">
      <div class="form-group">
        <label for="files">选择文件（支持多文件，最大10GB）</label>
        <input type="file" id="files" name="files" multiple required>
      </div>

      <div class="form-group">
        <label for="password">4位数字密码（已自动生成）</label>
        <div class="password-group">
          <input type="text" id="password" name="password" placeholder="****" maxlength="4" pattern="\\d{4}" required>
          <button type="button" class="generate-btn" id="generateBtn">重新生成</button>
        </div>
        <small style="color: #666; margin-top: 5px; display: block;">⚠️ 请务必记录此密码，下载时需要使用（可手动修改）</small>
      </div>

      <button type="submit" id="submitBtn">上传文件</button>
    </form>

    <div class="progress" id="progress">
      <div class="progress-bar">
        <div class="progress-fill" id="progressFill">0%</div>
      </div>
    </div>

    <div class="message" id="message"></div>
  </div>

  <script>
    const form = document.getElementById('uploadForm');
    const fileInput = document.getElementById('files');
    const submitBtn = document.getElementById('submitBtn');
    const message = document.getElementById('message');
    const progress = document.getElementById('progress');
    const progressFill = document.getElementById('progressFill');
    const passwordInput = document.getElementById('password');
    const generateBtn = document.getElementById('generateBtn');

    // 生成4位随机数字密码
    function generatePassword() {
      const password = Math.floor(1000 + Math.random() * 9000).toString();
      passwordInput.value = password;
      // 短暂高亮提示
      passwordInput.style.background = '#fffacd';
      setTimeout(() => {
        passwordInput.style.background = 'white';
      }, 500);
    }

    // 页面加载时自动生成密码
    generatePassword();

    // 点击按钮重新生成密码
    generateBtn.addEventListener('click', generatePassword);

    // 点击密码输入框时自动全选，方便复制
    passwordInput.addEventListener('click', function() {
      this.select();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const files = fileInput.files;
      const password = document.getElementById('password').value;

      if (!files || files.length === 0) {
        showMessage('请选择文件', 'error');
        return;
      }

      if (!/^\\d{4}$/.test(password)) {
        showMessage('密码必须是4位数字', 'error');
        return;
      }

      // 检查文件大小
      let totalSize = 0;
      for (const file of files) {
        totalSize += file.size;
      }

      if (totalSize > 10 * 1024 * 1024 * 1024) {
        showMessage('文件总大小超过10GB限制', 'error');
        return;
      }

      submitBtn.disabled = true;
      progress.style.display = 'block';
      message.style.display = 'none';

      try {
        let fileToUpload;

        // 判断是否需要打包
        const needZip = files.length > 1 || !files[0].name.toLowerCase().endsWith('.zip');

        if (needZip) {
          // 需要打包多个文件或单个非zip文件
          submitBtn.textContent = '正在打包文件...';
          updateProgress(10);

          const zip = new JSZip();

          // 添加所有文件到zip
          for (let i = 0; i < files.length; i++) {
            const file = files[i];
            zip.file(file.name, file);
            updateProgress(10 + (i + 1) / files.length * 30);
          }

          // 生成zip文件
          submitBtn.textContent = '正在生成压缩包...';
          const zipBlob = await zip.generateAsync({
            type: 'blob',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 }
          }, (metadata) => {
            updateProgress(40 + metadata.percent * 0.3);
          });

          fileToUpload = new File([zipBlob], 'files.zip', { type: 'application/zip' });
        } else {
          // 单个zip文件，直接使用
          fileToUpload = files[0];
        }

        // 上传文件
        submitBtn.textContent = '正在上传...';
        updateProgress(80);

        const formData = new FormData();
        formData.append('files', fileToUpload);
        formData.append('password', password);

        const response = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        });

        const result = await response.json();

        if (result.success) {
          updateProgress(100);
          const downloadUrl = window.location.origin + result.downloadUrl;
          showMessage(
            \`✅ 上传成功！<br><br><strong style="color: #d9534f;">⚠️ 请务必记录以下信息：</strong><br><br><strong>下载链接：</strong><div class="download-link"><a href="\${downloadUrl}" target="_blank">\${downloadUrl}</a></div><br><strong style="font-size: 18px; color: #d9534f;">密码：\${password}</strong><br><br>💡 链接30天内有效，请妥善保管密码！\`,
            'success'
          );
          form.reset();
          // 重新生成新密码供下次使用
          generatePassword();
        } else {
          showMessage('上传失败: ' + (result.error || '未知错误'), 'error');
        }
      } catch (error) {
        showMessage('上传失败: ' + error.message, 'error');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '上传文件';
        setTimeout(() => {
          progress.style.display = 'none';
          updateProgress(0);
        }, 2000);
      }
    });

    function updateProgress(percent) {
      progressFill.style.width = percent + '%';
      progressFill.textContent = Math.round(percent) + '%';
    }

    function showMessage(text, type) {
      message.innerHTML = text;
      message.className = 'message ' + type;
      message.style.display = 'block';
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
}

/**
 * 返回下载页面
 */
async function serveDownloadPage(fileId, env) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>下载文件 - FastFile</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; padding: 20px; min-height: 100vh; }
    .container { max-width: 500px; margin: 0 auto; background: white; border-radius: 12px; padding: 40px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    h1 { color: #333; margin-bottom: 30px; text-align: center; font-size: 26px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 10px; color: #555; font-weight: 500; font-size: 15px; }
    input[type="text"] { width: 100%; padding: 14px; border: 1px solid #ddd; border-radius: 8px; font-size: 20px; text-align: center; letter-spacing: 8px; font-weight: bold; min-height: 48px; }
    input[type="text"]:focus { outline: none; border-color: #28a745; box-shadow: 0 0 0 3px rgba(40,167,69,0.1); }
    button { width: 100%; padding: 16px; background: #28a745; color: white; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; transition: background 0.3s; min-height: 48px; font-weight: 500; }
    button:hover { background: #218838; }
    button:active { transform: scale(0.98); }
    button:disabled { background: #ccc; cursor: not-allowed; }
    .message { margin-top: 20px; padding: 16px; border-radius: 8px; display: none; line-height: 1.6; font-size: 14px; }
    .message.error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
    .file-info { margin-top: 20px; padding: 20px; background: #f8f9fa; border-radius: 8px; display: none; }
    .file-info p { margin-bottom: 12px; color: #555; font-size: 15px; line-height: 1.5; word-break: break-word; }
    .file-info p strong { color: #333; }
    .download-btn { margin-top: 15px; background: #007bff; }
    .download-btn:hover { background: #0056b3; }

    /* 平板电脑适配 */
    @media (max-width: 768px) {
      body { padding: 15px; }
      .container { padding: 30px 25px; }
      h1 { font-size: 23px; margin-bottom: 25px; }
      label { font-size: 14px; }
      input[type="text"] { font-size: 18px; letter-spacing: 6px; }
    }

    /* 手机适配 */
    @media (max-width: 480px) {
      body { padding: 10px; }
      .container { padding: 25px 20px; border-radius: 8px; }
      h1 { font-size: 20px; margin-bottom: 20px; }
      .form-group { margin-bottom: 16px; }
      label { font-size: 13px; margin-bottom: 8px; }
      input[type="text"] { padding: 12px; font-size: 18px; letter-spacing: 5px; min-height: 44px; }
      button { padding: 14px; font-size: 15px; min-height: 44px; }
      .message { padding: 12px; font-size: 13px; }
      .file-info { padding: 15px; }
      .file-info p { font-size: 14px; margin-bottom: 10px; }
    }

    /* 小屏幕手机适配 */
    @media (max-width: 360px) {
      .container { padding: 20px 15px; }
      h1 { font-size: 18px; }
      input[type="text"] { font-size: 16px; letter-spacing: 4px; }
      .file-info { padding: 12px; }
      .file-info p { font-size: 13px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔐 输入密码下载文件</h1>

    <form id="verifyForm">
      <div class="form-group">
        <label for="password">请输入4位数字密码</label>
        <input type="text" id="password" name="password" placeholder="****" maxlength="4" pattern="\\d{4}" required autofocus>
      </div>

      <button type="submit" id="submitBtn">验证密码</button>
    </form>

    <div class="message" id="message"></div>

    <div class="file-info" id="fileInfo">
      <p><strong>文件名：</strong><span id="fileName"></span></p>
      <p><strong>文件大小：</strong><span id="fileSize"></span></p>
      <button class="download-btn" id="downloadBtn">下载文件</button>
    </div>
  </div>

  <script>
    const fileId = '${fileId}';
    const form = document.getElementById('verifyForm');
    const submitBtn = document.getElementById('submitBtn');
    const message = document.getElementById('message');
    const fileInfo = document.getElementById('fileInfo');
    const downloadBtn = document.getElementById('downloadBtn');
    const passwordInput = document.getElementById('password');

    // 点击密码输入框时自动全选，方便粘贴
    passwordInput.addEventListener('click', function() {
      this.select();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const password = document.getElementById('password').value;

      if (!/^\\d{4}$/.test(password)) {
        showMessage('密码必须是4位数字');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = '验证中...';

      try {
        const response = await fetch('/api/verify', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ fileId, password }),
        });

        const result = await response.json();

        if (result.success) {
          // 显示文件信息
          document.getElementById('fileName').textContent = result.fileName;
          document.getElementById('fileSize').textContent = formatBytes(result.fileSize);
          fileInfo.style.display = 'block';
          message.style.display = 'none';
          form.style.display = 'none';

          // 设置下载链接
          downloadBtn.onclick = () => {
            window.location.href = result.downloadUrl;
          };
        } else {
          showMessage(result.error || '密码错误，请重试');
        }
      } catch (error) {
        showMessage('验证失败: ' + error.message);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '验证密码';
      }
    });

    function showMessage(text) {
      message.textContent = text;
      message.className = 'message error';
      message.style.display = 'block';
    }

    function formatBytes(bytes) {
      if (bytes === 0) return '0 Bytes';
      const k = 1024;
      const sizes = ['Bytes', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
}
