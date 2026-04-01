#!/usr/bin/env node
/**
 * 深度搜索 Zhipu X-Sign 生成函数
 */

async function main() {
  const content = await fetch('https://chatglm.cn/assets/main.3af2d5c8.js').then(r => r.text());
  console.log(`文件大小: ${(content.length / 1024).toFixed(0)}KB`);

  // 搜索 o0 函数定义 - 它返回 {timestamp, xNonce, sign}
  // 在 webpack 打包后，export 会用特定模式
  
  // 搜索关键字: "timestamp" + "xNonce" + "sign" 在一起
  const sigPatterns = [
    'xNonce',
    'timestamp.*xNonce.*sign',
    'function.*sign.*nonce',
    'o0:',
    '.o0=',
    'o0=function',
    'sign=',
  ];

  for (const pattern of sigPatterns) {
    const regex = new RegExp(pattern, 'gi');
    let match;
    let count = 0;
    while ((match = regex.exec(content)) !== null && count < 3) {
      count++;
      const start = Math.max(0, match.index - 200);
      const end = Math.min(content.length, match.index + 500);
      const snippet = content.slice(start, end).replace(/\n/g, ' ');
      console.log(`\n[${pattern}] #${count} at pos ${match.index}:`);
      console.log(`  ...${snippet}...`);
    }
  }

  // 特别搜索 MD5 + timestamp 的组合
  console.log('\n\n=== 搜索 MD5 与 timestamp/nonce 相关代码 ===');
  const md5Regex = /MD5\([^)]{0,200}\)/g;
  let md5Match;
  let md5Count = 0;
  while ((md5Match = md5Regex.exec(content)) !== null && md5Count < 10) {
    md5Count++;
    const start = Math.max(0, md5Match.index - 100);
    const end = Math.min(content.length, md5Match.index + 300);
    const snippet = content.slice(start, end).replace(/\n/g, ' ');
    console.log(`\n[MD5] #${md5Count} at pos ${md5Match.index}:`);
    console.log(`  ...${snippet}...`);
  }
}

main().catch(e => console.error(e.message));
