#!/usr/bin/env node
/**
 * 精确提取讯飞星火发送消息的 API 端点
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
    const name = url.split('/').pop().split('?')[0];
    if (name === '946.0d3473a0.chunk.js' || name === '2048.61ff4cb1.chunk.js') {
      jsFiles.set(name, params.requestId);
    }
  });

  await page.goto('https://xinghuo.xfyun.cn/desk', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);

  // 提取 946 chunk 中的发送逻辑
  for (const [name, requestId] of jsFiles) {
    try {
      const response = await cdpSession.send('Network.getResponseBody', { requestId });
      const body = response.body;
      
      console.log(`=== ${name} (${body.length} bytes) ===\n`);
      
      // 找到 chat_message 相关的完整代码块
      const patterns = ['chat_message', 'FormData', 'EventSource', 'event-stream', 'csend'];
      for (const pattern of patterns) {
        let idx = body.indexOf(pattern);
        let count = 0;
        while (idx !== -1 && count < 5) {
          const start = Math.max(0, idx - 200);
          const end = Math.min(body.length, idx + 200);
          console.log(`\n--- "${pattern}" @${idx} ---`);
          console.log(body.slice(start, end).replace(/\n/g, ' '));
          idx = body.indexOf(pattern, idx + 1);
          count++;
        }
      }

      // 专门搜索 "new EventSource" 或 EventSource 使用
      const esIdx = body.indexOf('EventSource');
      if (esIdx !== -1) {
        const start = Math.max(0, esIdx - 300);
        const end = Math.min(body.length, esIdx + 500);
        console.log('\n\n=== EventSource 完整上下文 ===');
        console.log(body.slice(start, end));
      }

      // 搜索 fetch 流式请求
      const fetchIdx = body.indexOf('text/event-stream');
      if (fetchIdx !== -1) {
        const start = Math.max(0, fetchIdx - 500);
        const end = Math.min(body.length, fetchIdx + 200);
        console.log('\n\n=== text/event-stream 上下文 ===');
        console.log(body.slice(start, end));
      }

      // 搜索 "/iflygpt" 开头的所有 URL
      console.log('\n\n=== 所有 /iflygpt 路径 ===');
      const regex = /["']\/iflygpt[^"']+["']/g;
      let match;
      const paths = new Set();
      while ((match = regex.exec(body)) !== null) {
        paths.add(match[0]);
      }
      for (const p of [...paths].sort()) {
        console.log(`  ${p}`);
      }
      
    } catch (e) {
      console.log(`  无法读取: ${e.message.slice(0, 80)}`);
    }
  }

  await page.close();
  browser.close();
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
