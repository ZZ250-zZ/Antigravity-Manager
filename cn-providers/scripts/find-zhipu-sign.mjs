#!/usr/bin/env node
/**
 * 从 Zhipu 的 JS 代码中查找 X-Sign 生成算法
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const page = await context.newPage();
  const cdpSession = await page.context().newCDPSession(page);

  await cdpSession.send('Network.enable');
  await cdpSession.send('Network.setCacheDisabled', { cacheDisabled: true });

  const jsFiles = [];
  cdpSession.on('Network.responseReceived', (params) => {
    if (params.response.url.endsWith('.js') && params.response.url.includes('chatglm')) {
      jsFiles.push({ url: params.response.url, requestId: params.requestId });
    }
  });

  await page.goto('https://chatglm.cn/main/chatfree', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  
  console.log(`收集到 ${jsFiles.length} 个 JS 文件`);
  
  // 搜索 X-Sign 或 x-sign 相关代码
  const patterns = ['X-Sign', 'x-sign', 'X-Nonce', 'x-nonce', 'generateSign', 'md5', 'MD5'];
  
  for (const jsFile of jsFiles) {
    try {
      const body = await cdpSession.send('Network.getResponseBody', { requestId: jsFile.requestId });
      const content = body.body;
      
      for (const pattern of patterns) {
        const idx = content.indexOf(pattern);
        if (idx >= 0) {
          // 获取包含该 pattern 的上下文
          const start = Math.max(0, idx - 200);
          const end = Math.min(content.length, idx + 300);
          const snippet = content.slice(start, end);
          console.log(`\n[${pattern}] in ${jsFile.url.split('/').pop()}`);
          console.log(`  ...${snippet}...`);
        }
      }
    } catch {
      // ignore - some responses might not be available
    }
  }

  // 也试试直接从页面 window 对象中找签名函数
  console.log('\n=== 从页面 window 中搜索 ===');
  const windowSearch = await page.evaluate(() => {
    const results = [];
    // 搜索全局变量中的签名相关函数
    for (const key of Object.keys(window)) {
      if (/sign|nonce|device/i.test(key)) {
        results.push(`window.${key}: ${typeof window[key]}`);
      }
    }
    return results;
  });
  console.log(windowSearch.join('\n') || '未找到');

  await page.close();
  browser.close();
}

main().catch(e => console.error(e.message));
