#!/usr/bin/env node
/**
 * 通过 CDP 抓取腾讯元宝的 API 请求和认证信息
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  console.log('=== Yuanbao API 抓取 ===\n');
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];

  // 获取 Yuanbao 的 cookies
  const cookies = await context.cookies();
  const yuanbaoCookies = cookies.filter(c => c.domain.includes('yuanbao.tencent.com'));
  
  console.log(`Yuanbao Cookies (${yuanbaoCookies.length} 个):`);
  for (const c of yuanbaoCookies) {
    console.log(`  ${c.name} = ${c.value.slice(0, 30)}... (domain: ${c.domain}, expires: ${c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'session'})`);
  }

  if (yuanbaoCookies.length === 0) {
    console.log('\n❌ 没有找到 Yuanbao 的 Cookie。请先在浏览器中登录 https://yuanbao.tencent.com');
    browser.close();
    return;
  }

  // 构造完整 Cookie 字符串
  const fullCookie = yuanbaoCookies.map(c => `${c.name}=${c.value}`).join('; ');
  console.log(`\n完整 Cookie 长度: ${fullCookie.length} 字符`);

  // 在浏览器中直接测试 API
  let page = context.pages().find(p => p.url().includes('yuanbao.tencent.com'));
  let needClose = false;
  if (!page) {
    page = await context.newPage();
    needClose = true;
    await page.goto('https://yuanbao.tencent.com/chat/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
  }
  
  console.log('\n页面 URL:', page.url());

  // 设置 CDP 抓包
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Network.enable');

  const captured = [];
  cdpSession.on('Network.requestWillBeSent', (params) => {
    const url = params.request.url;
    if (url.includes('yuanbao.tencent.com') && url.includes('/api/')) {
      captured.push({
        url,
        method: params.request.method,
        headers: params.request.headers,
        body: params.request.postData?.slice(0, 1000),
      });
      console.log(`📡 [${params.request.method}] ${url.split('?')[0]}`);
      if (params.request.postData) {
        console.log(`   Body: ${params.request.postData.slice(0, 500)}`);
      }
    }
  });

  cdpSession.on('Network.responseReceived', (params) => {
    const url = params.response.url;
    if (url.includes('yuanbao.tencent.com') && url.includes('/api/')) {
      console.log(`   ← ${params.response.status} ${url.split('?')[0]} [${params.response.headers['content-type'] || ''}]`);
    }
  });

  // 尝试在浏览器中通过 fetch 测试 API
  console.log('\n=== 浏览器上下文测试 API ===\n');
  const testResult = await page.evaluate(async () => {
    const results = [];
    
    // 测试 user info
    try {
      const r = await fetch('https://yuanbao.tencent.com/api/user/info', {
        headers: { 'Content-Type': 'application/json' },
      });
      const text = await r.text();
      results.push({ endpoint: '/api/user/info', status: r.status, data: text.slice(0, 200) });
    } catch (e) { results.push({ endpoint: '/api/user/info', error: e.message }); }

    // 测试 chat 发送 (简单测试)
    try {
      const chatId = crypto.randomUUID();
      const r = await fetch(`https://yuanbao.tencent.com/api/chat/${chatId}`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          prompt: '你好',
          model: 'gpt_175B_0404',
          chatId: '',
          displayPrompt: '你好',
          multimedia: [],
          plugin: '',
        }),
      });
      const text = await r.text();
      results.push({ endpoint: `/api/chat/${chatId}`, status: r.status, data: text.slice(0, 300) });
    } catch (e) { results.push({ endpoint: '/api/chat/...', error: e.message }); }

    return results;
  });

  for (const r of testResult) {
    console.log(`[${r.status || 'ERR'}] ${r.endpoint}`);
    if (r.error) console.log(`  Error: ${r.error}`);
    else console.log(`  Data: ${r.data}`);
  }

  // 等待用户操作
  console.log('\n⏳ 等待 20 秒抓取请求...');
  await page.waitForTimeout(20000);

  console.log(`\n=== 共抓取 ${captured.length} 个 API 请求 ===`);
  for (const req of captured) {
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(([k]) => 
        ['cookie', 'content-type', 'accept', 'origin', 'referer', 'authorization', 'x-requested-with'].includes(k.toLowerCase())
      )
    );
    console.log(`\n[${req.method}] ${req.url}`);
    console.log('Headers:', JSON.stringify(headers, null, 2));
    if (req.body) console.log('Body:', req.body);
  }

  if (needClose) await page.close();
  browser.close();
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
