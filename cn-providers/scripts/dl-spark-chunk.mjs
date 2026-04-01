#!/usr/bin/env node

async function main() {
  const urls = [
    'https://xhspdup.xfyun.cn/static/js/946.0d3473a0.chunk.js',
    'https://xhspdup.xfyun.cn/static/js/997.3daba822.chunk.js',
  ];
  
  for (const url of urls) {
    const name = url.split('/').pop();
    console.log('下载:', name);
    try {
      const res = await fetch(url);
      if (!res.ok) { console.log('  HTTP', res.status); continue; }
      const content = await res.text();
      console.log('  大小:', content.length, 'bytes');
      
      // 搜索 chat_message
      const cm = /['"]\/iflygpt[^'"]*chat_message[^'"]*['"]/g;
      let match;
      while ((match = cm.exec(content)) !== null) {
        console.log('  FOUND:', match[0]);
        const ctx = content.slice(Math.max(0, match.index - 120), match.index + 250);
        console.log('    CTX:', ctx.replace(/\n/g, ' ').slice(0, 370));
      }
      
      // EventSource
      let ei = content.indexOf('EventSource');
      if (ei !== -1) {
        const ctx = content.slice(Math.max(0, ei - 500), ei + 600);
        console.log('\n  EventSource:', ctx.replace(/\n/g, ' ').slice(0, 1000));
      }
      
      // FormData 字段
      const fdFields = new Set();
      const fdRegex = /\.append\(["']([^"']+)["']/g;
      while ((match = fdRegex.exec(content)) !== null) {
        fdFields.add(match[1]);
      }
      if (fdFields.size > 0) console.log('\n  FormData:', [...fdFields].join(', '));
      
      // 搜索 /u/chat/ 路径
      const chatRegex = /["']\/iflygpt[^"']*\/u\/chat[^"']*["']/g;
      while ((match = chatRegex.exec(content)) !== null) {
        console.log('  CHAT PATH:', match[0]);
      }
      
      // 搜索 csend
      let ci = content.indexOf('csend');
      if (ci !== -1) {
        const ctx = content.slice(Math.max(0, ci - 80), ci + 80);
        console.log('  csend:', ctx.replace(/\n/g, ' '));
      }
    } catch (e) {
      console.log('  ERROR:', e.message.slice(0, 80));
    }
  }
}

main();
