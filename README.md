# FastFile - 大文件中转应用

一个基于Cloudflare技术栈的无需注册的大文件中转应用，支持最大10GB文件的临时存储和分享。

## 功能特性

- ✅ **无需注册**：用户无需注册账号即可上传和下载文件
- ✅ **大文件支持**：支持最大10GB的文件上传
- ✅ **多文件上传**：支持一次性上传多个文件，自动打包为zip
- ✅ **密码保护**：使用4位数字密码保护文件安全
- ✅ **自动生成密码**：页面自动生成随机密码，可手动修改
- ✅ **自动过期**：文件默认保存30天后自动删除
- ✅ **中文界面**：完全中文化的用户界面
- ✅ **移动端适配**：完美支持手机和平板电脑访问
- ✅ **自定义域名**：支持绑定自己的域名
- ✅ **自动部署**：支持GitHub Actions自动部署

## 技术栈

- **前端**: HTML + CSS + JavaScript + JSZip
- **后端**: Cloudflare Workers
- **存储**:
  - Cloudflare R2 (文件存储)
  - Cloudflare KV (元数据存储)
- **部署**: GitHub Actions
- **CDN**: Cloudflare全球CDN

## 项目结构

```
fastfile/
├── .github/
│   └── workflows/
│       └── deploy.yml          # GitHub Actions部署配置
├── src/
│   ├── index.js                # Worker主文件
│   └── utils.js                # 工具函数
├── wrangler.toml               # Cloudflare配置
├── package.json                # 项目配置
├── DEPLOYMENT.md               # 详细部署指南
├── CUSTOM_DOMAIN.md            # 自定义域名快速配置指南
├── .gitignore
└── README.md
```

## 快速开始

### 本地开发

1. 克隆项目
```bash
git clone https://github.com/你的用户名/fastfile.git
cd fastfile
```

2. 安装依赖
```bash
npm install
```

3. 配置Cloudflare资源（参考DEPLOYMENT.md）

4. 本地运行
```bash
npm run dev
```

5. 访问 http://localhost:8787

### 部署到生产环境

详细部署步骤请查看 [DEPLOYMENT.md](./DEPLOYMENT.md)

### 配置自定义域名（可选）

FastFile支持使用自己的域名，如 `file.example.com`：

1. 域名必须托管在Cloudflare
2. 在Cloudflare Dashboard配置Workers路由
3. 添加DNS记录（AAAA记录，指向 `100::`）

**快速开始**：查看 [CUSTOM_DOMAIN.md](./CUSTOM_DOMAIN.md)（5分钟配置完成）

**详细指南**：查看 [DEPLOYMENT.md - 自定义域名配置](./DEPLOYMENT.md#自定义域名配置)

**优势**：
- 更专业的品牌形象
- 自定义域名更易记
- 支持多域名配置
- 与workers.dev域名并存

## 使用说明

### 上传文件

1. 访问应用首页
2. 点击"选择文件"按钮，选择一个或多个文件
3. 设置4位数字密码（例如：1234）
4. 点击"上传文件"按钮
5. 上传成功后会显示下载链接和密码
6. 将链接和密码分享给需要下载的人

### 下载文件

1. 打开分享的下载链接
2. 输入4位数字密码
3. 点击"验证密码"按钮
4. 验证成功后点击"下载文件"按钮

## 工作原理

1. **文件上传**：
   - 用户选择文件后，如果是多个文件或非zip文件，会在客户端使用JSZip自动打包为zip
   - 打包后的文件上传到Cloudflare R2存储
   - 密码经过SHA-256哈希后存储在KV中
   - 生成8位随机文件ID作为下载标识

2. **文件下载**：
   - 用户访问下载链接 `/d/{fileId}`
   - 输入密码后验证哈希值
   - 验证通过后生成临时下载令牌
   - 使用令牌从R2下载文件

3. **自动清理**：
   - Cloudflare Cron Triggers每天00:00执行清理任务
   - 检查所有文件的过期时间
   - 删除超过30天的文件和元数据

## 安全特性

- 密码使用SHA-256哈希存储，不保存明文
- 下载需要临时令牌验证
- 文件ID随机生成，难以猜测
- 自动过期机制防止文件长期占用空间

## 性能优化

- 客户端打包减轻服务器压力
- 利用Cloudflare全球CDN加速文件传输
- R2对象存储提供高性能读写
- KV缓存元数据减少数据库查询

## 限制说明

- 单次上传最大10GB（可在配置中修改）
- 文件保存30天（可在配置中修改）
- Cloudflare Workers单次请求最大128MB（大文件需要分块上传）
- KV操作有频率限制

## 自定义配置

可以通过修改源码来自定义以下配置：

- 文件保存天数（`src/utils.js` 中的 `getExpiryTime`）
- 文件大小限制（`src/index.js` 中的上传检查）
- 密码格式（`src/utils.js` 中的 `isValidPassword`）
- 界面样式（`src/index.js` 中的HTML内联样式）

## 开发计划

- [ ] 支持文件分块上传（突破100MB限制）
- [ ] 添加上传进度显示
- [ ] 支持自定义过期时间
- [ ] 添加文件下载次数限制
- [ ] 支持文件预览功能
- [ ] 添加管理后台

## 贡献

欢迎提交Issue和Pull Request！

## 许可证

MIT License

## 联系方式

如有问题或建议，请提交Issue。

---

**注意**：本项目使用Cloudflare服务，部分功能可能产生费用，请注意Cloudflare的定价政策。
