#!/usr/bin/env node
/**
 * 提取 Spark 发送消息 API - 通过 /chat 路径
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];

  // 关闭旧页面
  for (const p of context.pages()) {
    if (p.url().includes('xinghuo')) await p.close().catch(() => {});
  }
  await new Promise(r => setTimeout(r, 1000));

  const page = await context.newPage();
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Network.enable');
  // 禁用缓存以获取所有 JS 文件
  await cdpSession.send('Network.setCacheDisabled', { cacheDisabled: true });

  const jsFiles = new Map();
  cdpSession.on('Network.responseReceived', (params) => {
    const url = params.response.url;
    if (url.endsWith('.js') && !url.includes('itm.js') && !url.includes('vendors~') && !url.includes('es6-promise')) {
      jsFiles.set(params.requestId, url);
    }
  });

  console.log('导航到 /chat...');
  await page.goto('https://xinghuo.xfyun.cn/chat', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(10000);

  console.log(`找到 ${jsFiles.size} 个 JS 文件\n`);

  // 搜索 chat_message 相关 API
  const allPaths = new Set();
  for (const [requestId, url] of jsFiles) {
    const fileName = url.split('/').pop().split('?')[0];
    try {
      const response = await cdpSession.send('Network.getResponseBody', { requestId });
      const body = response.body;
      
      // 提取所有 /iflygpt 路径
      const regex = /["']\/iflygpt[^"']+["']/g;
      let match;
      while ((match = regex.exec(body)) !== null) {
        const path = match[0].replace(/['"]/g, '');
        allPaths.add(path);
        if (path.includes('chat_message') || path.includes('send') || path.includes('csend')) {
          console.log(`📌 [${fileName}] ${path}`);
          // 获取更多上下文
          const idx = match.index;
          const start = Math.max(0, idx - 200);
          const end = Math.min(body.length, idx + 300);
          console.log(`   上下文: ${body.slice(start, end).replace(/\n/g, ' ').slice(0, 400)}\n`);
        }
      }

      // 搜索 EventSource
      if (body.includes('EventSource')) {
        const idx = body.indexOf('EventSource');
        const start = Math.max(0, idx - 300);
        const end = Math.min(body.length, idx + 500);
        console.log(`\n🔥 [${fileName}] EventSource 上下文:`);
        console.log(body.slice(start, end).replace(/\n/g, ' ').slice(0, 800));
      }

      // 搜索 XMLHttpRequest + open
      if (body.includes('.open(') && body.includes('iflygpt')) {
        const openIndices = [];
        let oi = body.indexOf('.open(');
        while (oi !== -1) {
          const context = body.slice(Math.max(0, oi - 100), oi + 100);
          if (context.includes('iflygpt')) {
            console.log(`\n🔥 [${fileName}] XHR.open 上下文 @${oi}:`);
            console.log(body.slice(Math.max(0, oi - 200), oi + 200).replace(/\n/g, ' ').slice(0, 400));
          }
          oi = body.indexOf('.open(', oi + 1);
        }
      }

    } catch (e) {
      // 缓存可能不可用
    }
  }

  console.log('\n\n=== 所有 /iflygpt 路径 ===');
  const sorted = [...allPaths].sort();
  for (const p of sorted) {
    if (p.includes('chat') || p.includes('send') || p.includes('message')) {
      console.log(`  ★ ${p}`);
    }
  }
  
  console.log('\n其他路径:');
  for (const p of sorted) {
    if (!p.includes('chat') && !p.includes('send') && !p.includes('message')) {
      console.log(`  ${p}`);
    }
  }

  await page.close();
  browser.close();
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
