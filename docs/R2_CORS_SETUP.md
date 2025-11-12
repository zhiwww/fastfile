# R2 CORS 配置指南

由于API限制，需要通过Cloudflare Dashboard手动配置R2的CORS规则。

## 配置步骤

### 1. 登录Cloudflare Dashboard

访问：https://dash.cloudflare.com/

### 2. 进入R2管理页面

1. 在左侧菜单中找到 **R2**
2. 点击进入R2管理页面

### 3. 选择Bucket

找到并点击你的bucket：**fastfile-storage**

### 4. 配置CORS

1. 点击 **Settings** 标签页
2. 找到 **CORS Policy** 部分
3. 点击 **Add CORS Policy** 或 **Edit**
4. 输入以下配置：

#### 方法1：使用GUI配置（推荐）

- **Allowed Origins**:
  - `http://localhost:8787`
  - `https://*.workers.dev`
  - 你的自定义域名（如有）

- **Allowed Methods**:
  - ✓ GET
  - ✓ PUT
  - ✓ POST
  - ✓ DELETE
  - ✓ HEAD

- **Allowed Headers**:
  - `*` (所有headers)

- **Expose Headers**:
  - `ETag`
  - `Content-Length`
  - `Content-Type`

- **Max Age**: `3600` (秒)

#### 方法2：使用JSON配置（如果支持）

如果Dashboard支持直接输入JSON配置，可以复制下面的内容：

\`\`\`json
{
  "CORSRules": [
    {
      "AllowedOrigins": [
        "http://localhost:8787",
        "https://*.workers.dev"
      ],
      "AllowedMethods": [
        "GET",
        "PUT",
        "POST",
        "DELETE",
        "HEAD"
      ],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": [
        "ETag",
        "Content-Length",
        "Content-Type"
      ],
      "MaxAgeSeconds": 3600
    }
  ]
}
\`\`\`

### 5. 保存配置

点击 **Save** 保存配置。

### 6. 验证配置

配置完成后，重新测试上传功能。浏览器应该能够直接向R2发送PUT请求了。

## 测试CORS配置

配置完成后，可以在浏览器控制台测试：

\`\`\`javascript
// 测试OPTIONS预检请求
fetch('https://d0b4a3c0d1a23733be68ceb554d226b9.r2.cloudflarestorage.com/fastfile-storage/test', {
  method: 'OPTIONS',
  headers: {
    'Origin': 'http://localhost:8787',
    'Access-Control-Request-Method': 'PUT',
    'Access-Control-Request-Headers': 'content-type'
  }
}).then(response => {
  console.log('CORS Headers:', {
    'Access-Control-Allow-Origin': response.headers.get('Access-Control-Allow-Origin'),
    'Access-Control-Allow-Methods': response.headers.get('Access-Control-Allow-Methods'),
    'Access-Control-Allow-Headers': response.headers.get('Access-Control-Allow-Headers'),
  });
});
\`\`\`

## 常见问题

### Q: 配置后仍然有CORS错误？

A: 请确保：
1. CORS配置已保存
2. 刷新浏览器页面
3. 检查AllowedOrigins是否包含当前页面的origin

### Q: Wildcard (*) origin不工作？

A: R2可能不支持通配符origin，需要明确指定每个允许的域名。

### Q: 本地开发环境需要什么配置？

A: 至少需要添加：
- `http://localhost:8787` （本地开发服务器）
- `https://*.workers.dev` （生产环境）

## 下一步

配置完成后，继续运行：
\`\`\`bash
npm run dev
\`\`\`

然后测试文件上传功能。
