#!/usr/bin/env node
/**
 * 直接下载讯飞星火 JS 文件并搜索发送 API
 */

async function main() {
  // 先获取首页 HTML 找到 JS 文件 URL
  console.log('获取首页...');
  const html = await fetch('https://xinghuo.xfyun.cn/chat').then(r => r.text());
  
  // 提取 script src
  const srcRegex = /src="([^"]+\.js[^"]*)"/g;
  let match;
  const jsUrls = [];
  while ((match = srcRegex.exec(html)) !== null) {
    let url = match[1];
    if (!url.startsWith('http')) {
      url = `https://xinghuo.xfyun.cn${url}`;
    }
    jsUrls.push(url);
  }

  // 也从 /desk 获取
  const html2 = await fetch('https://xinghuo.xfyun.cn/desk').then(r => r.text());
  while ((match = srcRegex.exec(html2)) !== null) {
    let url = match[1];
    if (!url.startsWith('http')) {
      url = `https://xinghuo.xfyun.cn${url}`;
    }
    if (!jsUrls.includes(url)) jsUrls.push(url);
  }

  console.log(`找到 ${jsUrls.length} 个 JS 文件:`);
  for (const url of jsUrls) {
    console.log(`  ${url.split('/').pop().split('?')[0]}`);
  }

  // 下载并搜索每个 JS 文件
  for (const url of jsUrls) {
    const fileName = url.split('/').pop().split('?')[0];
    if (fileName.includes('vendors') || fileName.includes('es6-promise') || 
        fileName.includes('itm.js') || fileName.includes('sdk.js') || fileName.includes('gd.js')) {
      continue;
    }

    try {
      console.log(`\n下载 ${fileName}...`);
      const content = await fetch(url).then(r => r.text());
      console.log(`  大小: ${content.length} bytes`);

      // 搜索 chat_message 相关路径
      const chatMsgRegex = /["']\/iflygpt[^"']*chat_message[^"']*["']/g;
      while ((match = chatMsgRegex.exec(content)) !== null) {
        console.log(`  📌 ${match[0]}`);
        const idx = match.index;
        const ctx = content.slice(Math.max(0, idx - 150), idx + 200).replace(/\n/g, ' ');
        console.log(`     ...${ctx.slice(0, 350)}...`);
      }

      // 搜索 csend
      if (content.includes('csend')) {
        let idx = content.indexOf('csend');
        while (idx !== -1) {
          const ctx = content.slice(Math.max(0, idx - 100), idx + 100).replace(/\n/g, ' ');
          console.log(`  📌 csend @${idx}: ...${ctx.slice(0, 200)}...`);
          idx = content.indexOf('csend', idx + 1);
          if (idx === content.indexOf('csend', idx)) break;
        }
      }

      // 搜索 EventSource
      if (content.includes('EventSource')) {
        let idx = content.indexOf('new EventSource');
        if (idx === -1) idx = content.indexOf('EventSource(');
        if (idx !== -1) {
          const ctx = content.slice(Math.max(0, idx - 300), idx + 500).replace(/\n/g, ' ');
          console.log(`  🔥 EventSource @${idx}: ...${ctx.slice(0, 800)}...`);
        }
      }

      // 搜索 FormData + iflygpt
      if (content.includes('FormData') && content.includes('iflygpt')) {
        let idx = content.indexOf('FormData');
        let count = 0;
        while (idx !== -1 && count < 3) {
          const nearby = content.slice(Math.max(0, idx - 200), idx + 300);
          if (nearby.includes('iflygpt')) {
            console.log(`  📋 FormData + iflygpt @${idx}:`);
            console.log(`     ${nearby.replace(/\n/g, ' ').slice(0, 500)}`);
          }
          idx = content.indexOf('FormData', idx + 1);
          count++;
        }
      }

    } catch (e) {
      console.log(`  错误: ${e.message.slice(0, 80)}`);
    }
  }
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
