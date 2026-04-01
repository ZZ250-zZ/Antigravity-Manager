#!/usr/bin/env node
/**
 * 搜索讯飞星火 JS 中发送消息的 API
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const page = await context.newPage();
  
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Network.enable');

  const jsFiles = new Map();
  cdpSession.on('Network.responseReceived', (params) => {
    const url = params.response.url;
    if (url.endsWith('.js') && !url.includes('itm.js') && !url.includes('sdk.js') && !url.includes('gd.js') && !url.includes('vendors~')) {
      jsFiles.set(params.requestId, url);
    }
  });

  await page.goto('https://xinghuo.xfyun.cn/desk', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // 重点搜索关键词
  const patterns = [
    'send', 'Send', 'chat_list', 'chat-list', 'chatList',
    'completions', 'EventSource', 'event-stream',
    'GtToken', 'chatListId', 'content:', 'askWindow',
    '/u/chat', 'create', 'delete', 'conversation',
    'fetch(', 'axios.post', '.post(', '.get(',
  ];

  console.log(`搜索 ${jsFiles.size} 个应用 JS 文件...\n`);

  for (const [requestId, url] of jsFiles) {
    const fileName = url.split('/').pop().split('?')[0];
    try {
      const response = await cdpSession.send('Network.getResponseBody', { requestId });
      const body = response.body;
      
      // 搜索包含 "/iflygpt" 和 "send" 或 "chat" 的部分
      const lines = body.split(/[;{}]/);
      const interesting = lines.filter(line => 
        line.includes('/iflygpt') && (
          line.includes('send') || line.includes('Send') || 
          line.includes('chat') || line.includes('Chat') ||
          line.includes('create') || line.includes('delete') ||
          line.includes('event-stream') || line.includes('EventSource')
        )
      );
      
      if (interesting.length > 0) {
        console.log(`\n=== ${fileName} (${body.length} bytes) ===`);
        for (const line of interesting.slice(0, 10)) {
          console.log(`  ${line.trim().slice(0, 200)}`);
        }
      }

      // 特别搜索 EventSource 或 fetch + stream
      if (body.includes('EventSource') || body.includes('event-stream') || body.includes('text/event-stream')) {
        console.log(`\n🔥 [${fileName}] 包含 EventSource/SSE:`);
        let idx = 0;
        for (const keyword of ['EventSource', 'event-stream']) {
          idx = body.indexOf(keyword);
          while (idx !== -1 && idx < body.length) {
            const start = Math.max(0, idx - 150);
            const end = Math.min(body.length, idx + 150);
            console.log(`  @${idx}: ...${body.slice(start, end).replace(/\n/g, ' ')}...`);
            idx = body.indexOf(keyword, idx + keyword.length);
            if (idx !== -1) break; // Only show first occurrence
          }
        }
      }
    } catch (e) {
      // skip
    }
  }

  await page.close();
  browser.close();
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
