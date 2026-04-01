#!/usr/bin/env node
/**
 * 使用 CDP Fetch 拦截 Metaso 实际 API 请求
 * 需要用户手动在页面上发送一条消息
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];

  // 先收集 cookies
  const cookies = await context.cookies();
  const metasoCookies = cookies.filter(c => c.domain.includes('metaso'));
  console.log('=== Metaso Cookies ===');
  for (const c of metasoCookies) {
    console.log(`  ${c.name} = ${c.value.slice(0, 30)}... (domain: ${c.domain})`);
  }

  // 新建页面，导航到 metaso
  const page = await context.newPage();
  const cdpSession = await page.context().newCDPSession(page);

  // 启用 Fetch 拦截所有 metaso/files.metaso 请求
  await cdpSession.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*metaso*', requestStage: 'Request' },
      { urlPattern: '*files.metaso*', requestStage: 'Request' },
    ],
  });

  const capturedRequests = [];
  cdpSession.on('Fetch.requestPaused', async (params) => {
    const url = params.request.url;
    // 过滤静态资源
    if (/\.(js|css|png|jpg|svg|ico|woff|ttf|eot)(\?|$)/i.test(url)) {
      await cdpSession.send('Fetch.continueRequest', { requestId: params.requestId });
      return;
    }

    const info = {
      url,
      method: params.request.method,
      headers: params.request.headers,
      postData: params.request.postData || null,
    };
    capturedRequests.push(info);
    console.log(`\n[CAPTURED] ${info.method} ${url}`);
    if (info.postData) {
      console.log(`  Body: ${info.postData.slice(0, 500)}`);
    }

    await cdpSession.send('Fetch.continueRequest', { requestId: params.requestId });
  });

  console.log('\n正在导航到 metaso.cn ...');
  await page.goto('https://metaso.cn/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('页面已加载，当前URL:', page.url());

  console.log('\n>>> 请在 Metaso 页面上手动发送一条消息，等待 30 秒 <<<');
  await new Promise(r => setTimeout(r, 30000));

  console.log('\n=== 捕获的请求汇总 ===');
  for (const req of capturedRequests) {
    console.log(`\n${req.method} ${req.url}`);
    if (req.postData) {
      console.log(`  Body: ${req.postData.slice(0, 500)}`);
    }
    // 打印关键 header
    const interesting = ['content-type', 'authorization', 'cookie', 'x-', 'accept'];
    for (const [k, v] of Object.entries(req.headers)) {
      if (interesting.some(p => k.toLowerCase().startsWith(p))) {
        console.log(`  ${k}: ${v.slice(0, 100)}`);
      }
    }
  }

  await page.close();
  browser.close();
}

main().catch(e => console.error(e.message));
