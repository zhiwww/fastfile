/**
 * 工具函数集合
 */

// 生成随机文件ID（8位字符）
export function generateFileId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// 验证密码格式（4位数字）
export function isValidPassword(password) {
  return /^\d{4}$/.test(password);
}

// 计算过期时间（30天后）
export function getExpiryTime() {
  return Date.now() + 30 * 24 * 60 * 60 * 1000;
}

// 检查文件是否过期
export function isExpired(expiryTime) {
  return Date.now() > expiryTime;
}

// 简单的密码哈希（使用crypto API）
export async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// 验证密码
export async function verifyPassword(password, hashedPassword) {
  const hash = await hashPassword(password);
  return hash === hashedPassword;
}

// 解析multipart/form-data
export async function parseMultipartFormData(request) {
  const contentType = request.headers.get('content-type') || '';
  const boundary = contentType.split('boundary=')[1];

  if (!boundary) {
    throw new Error('No boundary found in Content-Type header');
  }

  const body = await request.arrayBuffer();
  const decoder = new TextDecoder();
  const bodyText = decoder.decode(body);

  const parts = bodyText.split(`--${boundary}`);
  const files = [];
  let password = '';

  for (const part of parts) {
    if (part.includes('Content-Disposition')) {
      const nameMatch = part.match(/name="([^"]+)"/);
      const filenameMatch = part.match(/filename="([^"]+)"/);

      if (nameMatch) {
        const name = nameMatch[1];

        if (name === 'password') {
          const contentStart = part.indexOf('\r\n\r\n') + 4;
          const contentEnd = part.lastIndexOf('\r\n');
          password = part.substring(contentStart, contentEnd);
        } else if (filenameMatch && name === 'files') {
          const filename = filenameMatch[1];
          const contentStart = part.indexOf('\r\n\r\n') + 4;
          const contentEnd = part.lastIndexOf('\r\n');

          // 将字符串转回ArrayBuffer
          const encoder = new TextEncoder();
          const content = encoder.encode(part.substring(contentStart, contentEnd));

          files.push({
            name: filename,
            content: content
          });
        }
      }
    }
  }

  return { files, password };
}

// 生成JSON响应
export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// 生成错误响应
export function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}
