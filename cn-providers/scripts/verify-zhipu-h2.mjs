/**
 * 智谱验证 - 深度调试
 * 对比 Node.js fetch vs 浏览器请求的关键差异
 */
import { chromium } from 'playwright';
import { randomUUID } from 'crypto';
import http2 from 'http2';

function uuid() { return randomUUID().replace(/-/g, ''); }

async function main() {
  console.log('=== 智谱深度调试 ===\n');

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  
  let capturedToken = null;
  let capturedHeaders = null;
  let capturedBody = null;
  let capturedUrl = null;

  page.on('request', req => {
    if (req.url().includes('chatglm.cn')) {
      const auth = req.headers()['authorization'];
      if (auth?.startsWith('Bearer ')) {
        capturedToken = auth.slice(7);
      }
    }
    if (req.url().includes('assistant/stream') && req.method() === 'POST') {
      capturedHeaders = req.headers();
      capturedBody = req.postData();
      capturedUrl = req.url();
    }
  });

  // 导航 + 通过UI发送消息
  await page.goto('https://chatglm.cn/main/alltoolsdetail', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(2000);

  // 通过 UI 发送消息
  const textarea = await page.$('textarea');
  if (textarea) {
    await textarea.click();
    await page.waitForTimeout(300);
    await textarea.fill('测试');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(5000);
  }

  await page.close().catch(() => {});

  if (!capturedHeaders || !capturedBody) {
    console.log('❌ 未捕获到聊天请求');
    process.exit(1);
  }

  console.log('浏览器成功请求的信息:');
  console.log(`  URL: ${capturedUrl?.slice(0, 80)}`);
  console.log(`  Token: ${capturedToken?.length} 字符`);
  
  // 对比：完全复制浏览器的请求（包括 cookies）
  const allCookies = await context.cookies('https://chatglm.cn');
  const cookieStr = allCookies.map(c => `${c.name}=${c.value}`).join('; ');

  console.log('\n--- Test 1: Node.js fetch (无 cookie, 无 x-sign) ---');
  {
    const resp = await fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${capturedToken}`,
        'Content-Type': 'application/json',
        'Referer': 'https://chatglm.cn/main/alltoolsdetail',
        'X-Device-Id': uuid(),
        'X-Request-Id': uuid(),
        'Accept': '*/*',
        'App-Name': 'chatglm',
        'Platform': 'pc',
        'Origin': 'https://chatglm.cn',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Version': '0.0.1',
      },
      body: capturedBody,
    });
    const text = await resp.text();
    console.log(`  HTTP: ${resp.status} - ${text.slice(0, 100)}`);
  }

  console.log('\n--- Test 2: Node.js fetch (有 cookie) ---');
  {
    const resp = await fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
      method: 'POST',
      headers: {
        ...capturedHeaders,
        'Cookie': cookieStr,
        'X-Request-Id': uuid(),
      },
      body: capturedBody,
    });
    const text = await resp.text();
    console.log(`  HTTP: ${resp.status} - ${text.slice(0, 100)}`);
  }

  console.log('\n--- Test 3: HTTP/2 直接请求 ---');
  await new Promise((resolve) => {
    const client = http2.connect('https://chatglm.cn');
    const req = client.request({
      ':method': 'POST',
      ':path': '/chatglm/backend-api/assistant/stream',
      'authorization': `Bearer ${capturedToken}`,
      'content-type': 'application/json',
      'referer': 'https://chatglm.cn/main/alltoolsdetail',
      'x-device-id': uuid(),
      'x-request-id': uuid(),
      'accept': '*/*',
      'app-name': 'chatglm',
      'platform': 'pc',
      'origin': 'https://chatglm.cn',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'version': '0.0.1',
    });
    
    req.write(capturedBody);
    req.end();

    let status = 0, data = '';
    req.on('response', (headers) => { status = headers[':status']; });
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      console.log(`  HTTP/2: ${status} - ${data.slice(0, 100)}`);
      client.close();
      resolve();
    });
    req.on('error', (e) => {
      console.log(`  ❌ ${e.message}`);
      client.close();
      resolve();
    });
  });

  console.log('\n--- Test 4: 页面内 fetch (same origin, 带 cookie) ---');
  {
    const page2 = await context.newPage();
    await page2.goto('https://chatglm.cn/main/alltoolsdetail', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page2.waitForTimeout(2000);
    
    const result = await page2.evaluate(async ({ body }) => {
      try {
        const resp = await fetch('/chatglm/backend-api/assistant/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
          body: body,
        });
        return { status: resp.status, text: (await resp.text()).slice(0, 200) };
      } catch(e) {
        return { error: e.message };
      }
    }, { body: capturedBody });
    
    console.log(`  page.evaluate: ${JSON.stringify(result).slice(0, 200)}`);
    await page2.close().catch(() => {});
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
