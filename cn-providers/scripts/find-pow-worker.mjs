#!/usr/bin/env node
/**
 * 查找 DeepSeek PoW Worker chunk 的文件名并下载分析其逻辑
 */

async function main() {
  const res = await fetch('https://fe-static.deepseek.com/chat/static/main.dd7fdf2b08.js');
  const text = await res.text();

  // 在 n.u 函数中找 chunk hash 映射
  const chunkIds = ['33614', '38401'];
  
  // 从整个 bundle 中搜索这些 chunk ID 附近的 hash
  for (const id of chunkIds) {
    // 搜索 id:"hash" 格式
    const regex = new RegExp(`${id}:"([a-f0-9]{10,})"`, 'g');
    let match;
    while ((match = regex.exec(text)) !== null) {
      const hash = match[1];
      const url = `https://fe-static.deepseek.com/chat/static/${id}.${hash}.js`;
      console.log(`[chunk ${id}] hash=${hash} url=${url}`);
      
      // 下载 worker chunk
      try {
        const chunkRes = await fetch(url);
        if (chunkRes.ok) {
          const chunkText = await chunkRes.text();
          console.log(`  Size: ${chunkText.length}`);
          
          // 搜索关键函数
          const keywords = ['wasm_solve', 'sha3', 'keccak', 'difficulty', 'challenge', 'prefix', 'solve', 'hash'];
          for (const kw of keywords) {
            const idx = chunkText.indexOf(kw);
            if (idx !== -1) {
              console.log(`  [${kw}] at ${idx}: ${chunkText.slice(Math.max(0, idx - 30), Math.min(chunkText.length, idx + 150))}`);
            }
          }
        } else {
          console.log(`  Fetch failed: ${chunkRes.status}`);
        }
      } catch (e) {
        console.log(`  Error: ${e.message}`);
      }
    }
  }
}

main().catch(console.error);
