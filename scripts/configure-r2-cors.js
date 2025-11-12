/**
 * 配置R2 Bucket的CORS规则
 * 使用aws4fetch库通过S3 API配置R2
 */

import { AwsClient } from 'aws4fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 从.dev.vars读取环境变量
function loadEnvVars() {
  const envPath = path.join(__dirname, '../.dev.vars');
  const envContent = fs.readFileSync(envPath, 'utf-8');
  const envVars = {};

  envContent.split('\n').forEach(line => {
    const trimmedLine = line.trim();
    if (trimmedLine && !trimmedLine.startsWith('#')) {
      const [key, ...valueParts] = trimmedLine.split('=');
      const value = valueParts.join('=').replace(/^["']|["']$/g, '');
      envVars[key.trim()] = value.trim();
    }
  });

  return envVars;
}

async function configureCORS() {
  console.log('📋 配置R2 Bucket CORS规则...\n');

  // 加载环境变量
  const env = loadEnvVars();
  const accountId = env.R2_ACCOUNT_ID;
  const bucketName = env.R2_BUCKET_NAME || 'fastfile-storage';
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    console.error('❌ 缺少必要的环境变量');
    console.error('请确保.dev.vars文件包含以下变量：');
    console.error('- R2_ACCOUNT_ID');
    console.error('- R2_ACCESS_KEY_ID');
    console.error('- R2_SECRET_ACCESS_KEY');
    process.exit(1);
  }

  console.log(`🪣 Bucket: ${bucketName}`);
  console.log(`🔑 Account ID: ${accountId}\n`);

  // 创建AWS客户端
  const client = new AwsClient({
    accessKeyId,
    secretAccessKey,
  });

  const r2Url = `https://${accountId}.r2.cloudflarestorage.com/${bucketName}`;

  // 读取CORS配置
  const corsConfigPath = path.join(__dirname, '../r2-cors-config.json');
  const corsConfig = JSON.parse(fs.readFileSync(corsConfigPath, 'utf-8'));

  // 转换JSON配置为XML格式（S3 API要求）
  const corsXml = buildCorsXml(corsConfig);

  console.log('📄 CORS配置XML:');
  console.log(corsXml);
  console.log('');

  try {
    // 应用CORS配置
    console.log('⬆️  正在上传CORS配置到R2...');
    const response = await client.fetch(`${r2Url}?cors`, {
      method: 'PUT',
      body: corsXml,
      headers: {
        'Content-Type': 'application/xml',
      },
    });

    if (response.ok) {
      console.log('✅ CORS配置成功！');
      console.log(`\n🎉 Bucket "${bucketName}" 的CORS规则已更新\n`);

      // 验证配置
      console.log('🔍 验证CORS配置...');
      const verifyResponse = await client.fetch(`${r2Url}?cors`, {
        method: 'GET',
      });

      if (verifyResponse.ok) {
        const verifyXml = await verifyResponse.text();
        console.log('✅ 当前CORS配置:');
        console.log(verifyXml);
      }
    } else {
      const errorText = await response.text();
      console.error('❌ CORS配置失败:');
      console.error(`状态码: ${response.status}`);
      console.error(`错误信息: ${errorText}`);
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ 配置过程出错:', error.message);
    process.exit(1);
  }
}

/**
 * 将JSON格式的CORS配置转换为XML
 */
function buildCorsXml(config) {
  const rules = config.CORSRules.map(rule => {
    const origins = rule.AllowedOrigins.map(o => `<AllowedOrigin>${o}</AllowedOrigin>`).join('');
    const methods = rule.AllowedMethods.map(m => `<AllowedMethod>${m}</AllowedMethod>`).join('');
    const headers = rule.AllowedHeaders.map(h => `<AllowedHeader>${h}</AllowedHeader>`).join('');
    const exposeHeaders = rule.ExposeHeaders ?
      rule.ExposeHeaders.map(h => `<ExposeHeader>${h}</ExposeHeader>`).join('') : '';
    const maxAge = rule.MaxAgeSeconds ? `<MaxAgeSeconds>${rule.MaxAgeSeconds}</MaxAgeSeconds>` : '';

    return `
    <CORSRule>
      ${origins}
      ${methods}
      ${headers}
      ${exposeHeaders}
      ${maxAge}
    </CORSRule>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  ${rules}
</CORSConfiguration>`;
}

// 运行配置
configureCORS().catch(error => {
  console.error('❌ 未捕获的错误:', error);
  process.exit(1);
});
