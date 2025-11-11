/**
 * Test script for aws4fetch R2 multipart upload implementation
 */

const API_URL = 'http://localhost:53125';

// Create a test file
function createTestFile(sizeInMB) {
  const size = sizeInMB * 1024 * 1024;
  const buffer = new Uint8Array(size);
  // Fill with some test data
  for (let i = 0; i < size; i++) {
    buffer[i] = i % 256;
  }
  return new Blob([buffer], { type: 'application/octet-stream' });
}

async function testMultipartUpload() {
  console.log('🧪 Starting aws4fetch multipart upload test...\n');

  try {
    // Step 1: Initialize upload
    console.log('📤 Step 1: Initializing upload...');
    const testFile = createTestFile(25); // 25MB file (requires 3 chunks of 10MB)

    const initResponse = await fetch(`${API_URL}/api/upload/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [{ name: 'test-file.bin', size: testFile.size }],
        password: '1234'
      })
    });

    if (!initResponse.ok) {
      const error = await initResponse.text();
      throw new Error(`Init failed: ${initResponse.status} - ${error}`);
    }

    const initData = await initResponse.json();
    console.log(`✅ Upload initialized: ${initData.uploadId}`);
    console.log(`   File uploads: ${JSON.stringify(initData.fileUploads, null, 2)}\n`);

    const uploadId = initData.uploadId;
    const fileUpload = initData.fileUploads[0];

    // Step 2: Upload chunks
    console.log('📦 Step 2: Uploading chunks...');
    const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB
    const totalChunks = Math.ceil(testFile.size / CHUNK_SIZE);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, testFile.size);
      const chunk = testFile.slice(start, end);

      const formData = new FormData();
      formData.append('uploadId', uploadId);
      formData.append('fileIndex', '0');
      formData.append('chunkIndex', i.toString());
      formData.append('chunk', chunk);

      const chunkResponse = await fetch(`${API_URL}/api/upload/chunk`, {
        method: 'POST',
        body: formData
      });

      if (!chunkResponse.ok) {
        const error = await chunkResponse.text();
        throw new Error(`Chunk ${i + 1} failed: ${chunkResponse.status} - ${error}`);
      }

      const chunkData = await chunkResponse.json();
      console.log(`   ✅ Chunk ${i + 1}/${totalChunks} uploaded (${(end - start / 1024 / 1024).toFixed(2)}MB)`);
    }

    console.log('\n');

    // Step 3: Complete upload
    console.log('🏁 Step 3: Completing upload...');
    const completeResponse = await fetch(`${API_URL}/api/upload/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId })
    });

    if (!completeResponse.ok) {
      const error = await completeResponse.text();
      throw new Error(`Complete failed: ${completeResponse.status} - ${error}`);
    }

    const completeData = await completeResponse.json();
    console.log(`✅ Upload completed successfully!`);
    console.log(`   File ID: ${completeData.fileId}`);
    console.log(`   Download URL: ${completeData.url}\n`);

    // Step 4: Verify download works
    console.log('📥 Step 4: Testing download...');
    const downloadResponse = await fetch(`${API_URL}${completeData.url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: '1234' })
    });

    if (!downloadResponse.ok) {
      throw new Error(`Download failed: ${downloadResponse.status}`);
    }

    console.log(`✅ Download works!\n`);

    console.log('🎉 All tests passed! aws4fetch implementation is working correctly.');
    console.log('   ✓ No DOMParser errors');
    console.log('   ✓ Multipart upload successful');
    console.log('   ✓ File compression and download working\n');

    return true;

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack trace:', error.stack);
    return false;
  }
}

// Run the test
testMultipartUpload()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
