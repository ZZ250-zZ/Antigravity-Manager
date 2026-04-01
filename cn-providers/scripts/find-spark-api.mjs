#!/usr/bin/env node
/**
 * 搜索讯飞星火 JS bundle 中的 API 端点
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  console.log('=== 搜索 Spark API 端点 ===\n');
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];

  const page = await context.newPage();
  
  // CDP 抓包找到 JS 文件
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Network.enable');

  const jsFiles = [];
  cdpSession.on('Network.responseReceived', (params) => {
    const url = params.response.url;
    if (url.includes('xinghuo.xfyun.cn') && url.endsWith('.js') && !url.includes('itm.js')) {
      jsFiles.push({ url, requestId: params.requestId });
    }
  });

  await page.goto('https://xinghuo.xfyun.cn/chat', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(5000);

  console.log(`找到 ${jsFiles.length} 个 JS 文件`);

  // 搜索每个 JS 文件中的 API 路径
  const apiPatterns = ['send_text', 'send/text', 'chat/send', 'completions', 'chat_list', 'chat-list', '/chat/', 'chatCompletion', 'sendMessage', 'askQuestion', 'GtToken'];
  
  for (const jsFile of jsFiles) {
    try {
      const response = await cdpSession.send('Network.getResponseBody', { requestId: jsFile.requestId });
      const body = response.body;
      
      for (const pattern of apiPatterns) {
        const idx = body.indexOf(pattern);
        if (idx !== -1) {
          // 提取上下文
          const start = Math.max(0, idx - 100);
          const end = Math.min(body.length, idx + 100);
          const snippet = body.slice(start, end);
          const fileName = jsFile.url.split('/').pop().split('?')[0];
          console.log(`\n📌 [${fileName}] 包含 "${pattern}":`);
          console.log(`   ...${snippet}...`);
        }
      }
    } catch (e) {
      // 缓存的 JS 文件可能无法获取
    }
  }

  // 也尝试从页面的全局变量中找信息
  const globals = await page.evaluate(() => {
    const info = {};
    // 检查常见的配置变量
    if (window.__NEXT_DATA__) info.__NEXT_DATA__ = JSON.stringify(window.__NEXT_DATA__).slice(0, 500);
    if (window.__APP_CONFIG__) info.__APP_CONFIG__ = JSON.stringify(window.__APP_CONFIG__).slice(0, 500);
    if (window.SPARK_CONFIG) info.SPARK_CONFIG = JSON.stringify(window.SPARK_CONFIG).slice(0, 500);
    
    // 检查 Service Worker
    if (navigator.serviceWorker?.controller) {
      info.serviceWorker = navigator.serviceWorker.controller.scriptURL;
    }
    
    return info;
  });
  
  console.log('\n\n全局变量:', JSON.stringify(globals, null, 2));

  await page.close();
  browser.close();
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
