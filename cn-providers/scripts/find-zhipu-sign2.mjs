#!/usr/bin/env node
/**
 * 下载 Zhipu JS 文件并搜索 X-Sign 生成算法
 */

async function main() {
  // 先获取 HTML 以找到 JS 文件
  const html = await fetch('https://chatglm.cn/main/chatfree').then(r => r.text());
  
  // 提取所有 JS URL
  const jsUrls = [];
  const srcRegex = /src="([^"]*\.js[^"]*)"/g;
  let match;
  while ((match = srcRegex.exec(html)) !== null) {
    let url = match[1];
    if (url.startsWith('/')) url = 'https://chatglm.cn' + url;
    jsUrls.push(url);
  }
  
  console.log(`找到 ${jsUrls.length} 个 JS 文件`);
  
  const patterns = ['X-Sign', 'x-sign', '"X-Nonce"', '"x-nonce"', 'X-Request-Id', 'X-Device-Id', 'md5(', 'MD5(', 'generateSign', 'getSign'];
  
  for (const url of jsUrls) {
    try {
      const content = await fetch(url).then(r => r.text());
      const fileName = url.split('/').pop()?.split('?')[0];
      
      let found = false;
      for (const pattern of patterns) {
        let idx = content.indexOf(pattern);
        while (idx >= 0) {
          if (!found) {
            found = true;
            console.log(`\n=== ${fileName} (${(content.length / 1024).toFixed(0)}KB) ===`);
          }
          const start = Math.max(0, idx - 300);
          const end = Math.min(content.length, idx + 400);
          const snippet = content.slice(start, end);
          console.log(`\n[${pattern}] at pos ${idx}:`);
          console.log(`  ...${snippet.replace(/\n/g, ' ')}...`);
          
          // 找下一个出现
          idx = content.indexOf(pattern, idx + pattern.length);
          // 只打印前3个
          if (idx >= 0 && content.indexOf(pattern, idx + pattern.length) >= 0) {
            console.log('  ... (更多出现)');
            break;
          }
        }
      }
    } catch (e) {
      console.log(`下载失败: ${url}: ${e.message}`);
    }
  }
}

main().catch(e => console.error(e.message));
