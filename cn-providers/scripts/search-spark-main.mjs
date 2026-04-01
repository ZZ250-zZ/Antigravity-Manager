#!/usr/bin/env node
/**
 * 搜索 Spark main.js 中的聊天 API 端点
 */

async function main() {
  // 下载 main.3df81b40.js - 这个文件包含应用代码
  const url = 'https://xinghuo.xfyun.cn/chat/static/js/main.3df81b40.js';
  const url2 = 'https://xhspdup.xfyun.cn/static/js/main.3df81b40.js';
  
  let content;
  for (const u of [url, url2]) {
    try {
      console.log(`下载 ${u}...`);
      const res = await fetch(u);
      if (res.ok) {
        content = await res.text();
        console.log(`✅ 大小: ${content.length} bytes`);
        break;
      }
    } catch { /* continue */ }
  }

  if (!content) {
    // 尝试主域名
    const mainUrl = 'https://xinghuo.xfyun.cn/static/js/main.3df81b40.js';
    console.log(`下载 ${mainUrl}...`);
    const res = await fetch(mainUrl);
    content = await res.text();
    console.log(`大小: ${content.length} bytes`);
  }

  // 搜索聊天相关 API
  console.log('\n=== 搜索 chat_message ===');
  const chatMsgRegex = /["']\/iflygpt[^"']*chat_message[^"']*["']/g;
  let match;
  const chatPaths = new Set();
  while ((match = chatMsgRegex.exec(content)) !== null) {
    chatPaths.add(match[0]);
    const ctx = content.slice(Math.max(0, match.index - 80), match.index + 150).replace(/\n/g, ' ');
    console.log(`  ${match[0]}`);
    console.log(`  上下文: ${ctx.slice(0, 230)}`);
  }

  console.log('\n=== 搜索 EventSource ===');
  let esIdx = content.indexOf('EventSource');
  let count = 0;
  while (esIdx !== -1 && count < 5) {
    const ctx = content.slice(Math.max(0, esIdx - 400), esIdx + 400).replace(/\n/g, ' ');
    console.log(`\n@${esIdx}: ${ctx.slice(0, 800)}`);
    esIdx = content.indexOf('EventSource', esIdx + 1);
    count++;
  }

  console.log('\n=== 搜索 send ===');
  const sendRegex = /["']\/iflygpt[^"']*send[^"']*["']/g;
  while ((match = sendRegex.exec(content)) !== null) {
    console.log(`  ${match[0]}`);
  }

  console.log('\n=== 搜索 csend ===');
  let csIdx = content.indexOf('csend');
  while (csIdx !== -1) {
    const ctx = content.slice(Math.max(0, csIdx - 80), csIdx + 80).replace(/\n/g, ' ');
    console.log(`  @${csIdx}: ${ctx.slice(0, 160)}`);
    csIdx = content.indexOf('csend', csIdx + 5);
  }

  // 下载 /chat 页面的 main.js
  console.log('\n=== 尝试 /chat 路由的 main.js ===');
  // 获取 /chat 页面 HTML
  const chatHtml = await fetch('https://xinghuo.xfyun.cn/chat').then(r => r.text());
  // 搜索 chunk 文件路径
  const chunkRegex = /["']((?:\/|https:\/\/)[^"']*chunk\.js[^"']*)["']/g;
  const chunks = new Set();
  while ((match = chunkRegex.exec(chatHtml)) !== null) {
    chunks.add(match[1]);
  }
  
  // 也搜索 main.js 中 webpack 的 chunk 映射
  const webpackRegex = /(\d+):"([a-f0-9]+)"/g;
  const chunkMap = {};
  while ((match = webpackRegex.exec(content)) !== null) {
    chunkMap[match[1]] = match[2];
  }
  
  // 找到 946 chunk 的 hash
  if (chunkMap['946']) {
    const chunkUrl = `https://xhspdup.xfyun.cn/static/js/946.${chunkMap['946']}.chunk.js`;
    console.log(`\n946 chunk: ${chunkUrl}`);
    try {
      const chunkContent = await fetch(chunkUrl).then(r => r.text());
      console.log(`大小: ${chunkContent.length} bytes`);
      
      // 搜索 chat_message
      const cm = /["']\/iflygpt[^"']*chat_message[^"']*["']/g;
      while ((match = cm.exec(chunkContent)) !== null) {
        console.log(`  📌 ${match[0]}`);
        const ctx = chunkContent.slice(Math.max(0, match.index - 100), match.index + 200).replace(/\n/g, ' ');
        console.log(`     ${ctx.slice(0, 300)}`);
      }
      
      // 搜索 EventSource
      let ei = chunkContent.indexOf('EventSource');
      if (ei !== -1) {
        const ctx = chunkContent.slice(Math.max(0, ei - 400), ei + 600).replace(/\n/g, ' ');
        console.log(`\n  🔥 EventSource: ${ctx.slice(0, 1000)}`);
      }

      // FormData fields
      const fdFields = new Set();
      const fdRegex = /\.append\("([^"]+)"/g;
      while ((match = fdRegex.exec(chunkContent)) !== null) {
        fdFields.add(match[1]);
      }
      console.log(`\n  FormData 字段: ${[...fdFields].join(', ')}`);
    } catch (e) {
      console.log(`  错误: ${e.message.slice(0, 80)}`);
    }
  }
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
