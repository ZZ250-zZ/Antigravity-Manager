#!/usr/bin/env node
/**
 * 通过 CDP 抓取 Metaso 实际搜索 API
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];

  const page = await context.newPage();
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Network.enable');

  const captured = [];
  cdpSession.on('Network.requestWillBeSent', (params) => {
    const url = params.request.url;
    if (url.includes('metaso.cn') && (url.includes('/api/') || url.includes('/search'))) {
      captured.push({
        url,
        method: params.request.method,
        headers: params.request.headers,
        body: params.request.postData?.slice(0, 1000),
      });
      console.log(`📡 [${params.request.method}] ${url}`);
      if (params.request.postData) {
        console.log(`   Body: ${params.request.postData.slice(0, 500)}`);
      }
    }
  });

  cdpSession.on('Network.responseReceived', (params) => {
    const url = params.response.url;
    if (url.includes('metaso.cn') && (url.includes('/api/') || url.includes('/search'))) {
      console.log(`   ← ${params.response.status} ${url} [${params.response.headers['content-type'] || ''}]`);
    }
  });

  // 导航到 Metaso
  await page.goto('https://metaso.cn/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  console.log('URL:', page.url());

  // 找输入框并搜索
  const input = await page.$('input[type="text"]') || await page.$('textarea') || await page.$('input');
  if (input) {
    console.log('\n找到输入框，发送搜索...');
    await input.click();
    await page.waitForTimeout(300);
    await page.keyboard.type('你好', { delay: 50 });
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    console.log('已发送搜索');
    await page.waitForTimeout(15000);
  } else {
    console.log('未找到输入框');
    // 分析页面
    const elements = await page.evaluate(() => ({
      inputs: document.querySelectorAll('input').length,
      textareas: document.querySelectorAll('textarea').length,
      title: document.title,
      bodyText: document.body?.innerText?.slice(0, 200),
    }));
    console.log('页面:', JSON.stringify(elements, null, 2));
  }

  console.log(`\n=== 共抓取 ${captured.length} 个 API 请求 ===`);
  for (const req of captured) {
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(([k]) =>
        ['content-type', 'cookie', 'accept', 'origin', 'referer', 'authorization'].includes(k.toLowerCase())
      )
    );
    console.log(`\n[${req.method}] ${req.url}`);
    console.log('Headers:', JSON.stringify(headers, null, 2));
    if (req.body) console.log('Body:', req.body);
  }

  await page.close();
  browser.close();
}

main().catch(e => console.error(e));
