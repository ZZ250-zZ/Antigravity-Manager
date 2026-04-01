#!/usr/bin/env node
/**
 * 搜索讯飞星火 JS bundle 中的 API 端点 - v2
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  console.log('=== 搜索 Spark API v2 ===\n');
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];

  const page = await context.newPage();
  
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Network.enable');

  const jsFiles = [];
  cdpSession.on('Network.responseReceived', (params) => {
    const url = params.response.url;
    // 匹配所有 JS 文件
    if (url.endsWith('.js') || url.includes('.chunk.js') || url.includes('.bundle.js')) {
      jsFiles.push({ url, requestId: params.requestId, size: params.response.headers?.['content-length'] });
    }
  });

  await page.goto('https://xinghuo.xfyun.cn/desk', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(5000);

  console.log(`找到 ${jsFiles.length} 个 JS 文件:`);
  for (const f of jsFiles) {
    console.log(`  ${f.url.split('/').pop().split('?')[0]} (${f.size || '?'} bytes)`);
  }

  // 搜索每个 JS 文件
  const apiPatterns = [
    'send_text', 'send/text', 'sendText', 'sendMessage', 
    'GtToken', 'chatListId', 'chat/completions',
    '/u/chat/', 'chat-list/create', 'chat_list/create',
    'iflygpt', 'EventSource', 'text/event-stream',
  ];
  
  let found = 0;
  for (const jsFile of jsFiles) {
    try {
      const response = await cdpSession.send('Network.getResponseBody', { requestId: jsFile.requestId });
      const body = response.body;
      const fileName = jsFile.url.split('/').pop().split('?')[0];
      
      for (const pattern of apiPatterns) {
        let lastIdx = -1;
        let idx = body.indexOf(pattern);
        let count = 0;
        while (idx !== -1 && count < 3) {
          const start = Math.max(0, idx - 80);
          const end = Math.min(body.length, idx + 80);
          const snippet = body.slice(start, end).replace(/\n/g, ' ');
          console.log(`\n📌 [${fileName}] "${pattern}" @${idx}:`);
          console.log(`   ${snippet}`);
          found++;
          count++;
          lastIdx = idx;
          idx = body.indexOf(pattern, idx + pattern.length);
        }
      }
    } catch (e) {
      // 缓存的文件可能拿不到
    }
  }
  
  if (found === 0) {
    console.log('\n没有在 JS 文件中找到相关 API 模式');
    
    // 尝试从页面 scripts 标签获取
    const scripts = await page.evaluate(() => {
      const all = document.querySelectorAll('script[src]');
      return Array.from(all).map(s => s.src);
    });
    console.log('\n页面 script 标签:');
    for (const s of scripts) {
      console.log(`  ${s}`);
    }
  }

  await page.close();
  browser.close();
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
