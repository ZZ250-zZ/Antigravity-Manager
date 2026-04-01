#!/usr/bin/env node
/**
 * 在浏览器中自动发送消息并拦截 Zhipu 实际 API
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const page = await context.newPage();
  const cdpSession = await page.context().newCDPSession(page);

  await cdpSession.send('Network.enable');

  const capturedRequests = [];
  const capturedResponses = new Map();

  cdpSession.on('Network.requestWillBeSent', (params) => {
    const url = params.request.url;
    if (!/chatglm|zhipu/i.test(url)) return;
    if (/\.(js|css|png|jpg|svg|ico|woff|ttf|eot|webp)(\?|$)/i.test(url)) return;

    capturedRequests.push({
      requestId: params.requestId,
      url,
      method: params.request.method,
      headers: params.request.headers,
      postData: params.request.postData || null,
    });

    if (url.includes('stream') || url.includes('chat') || url.includes('token') || url.includes('refresh') || url.includes('auth')) {
      console.log(`[REQ] ${params.request.method} ${url}`);
      if (params.request.postData) {
        console.log(`  Body: ${params.request.postData.slice(0, 500)}`);
      }
      // 打印关键 header
      for (const [k, v] of Object.entries(params.request.headers)) {
        if (/^(authorization|cookie|content-type|accept|x-|app)/i.test(k)) {
          console.log(`  ${k}: ${String(v).slice(0, 200)}`);
        }
      }
    }
  });

  cdpSession.on('Network.responseReceived', (params) => {
    capturedResponses.set(params.requestId, {
      status: params.response.status,
      headers: params.response.headers,
    });

    if (params.response.url.includes('stream') || params.response.url.includes('token') || params.response.url.includes('refresh') || params.response.url.includes('auth')) {
      console.log(`[RESP] ${params.response.status} ${params.response.url}`);
    }
  });

  console.log('导航到 chatglm.cn ...');
  await page.goto('https://chatglm.cn/main/chatfree', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  console.log('当前URL:', page.url());

  // 检查 cookies
  const cookies = await context.cookies();
  const zhipuCookies = cookies.filter(c => c.domain.includes('chatglm'));
  console.log('\n=== 当前 Cookies ===');
  for (const c of zhipuCookies) {
    console.log(`  ${c.name} = ${c.value.slice(0, 40)}... (expires: ${new Date(c.expires * 1000).toISOString().slice(0, 19)})`);
  }

  // 查找输入框
  const inputInfo = await page.evaluate(() => {
    const textareas = document.querySelectorAll('textarea');
    const editables = document.querySelectorAll('[contenteditable="true"]');
    const inputs = document.querySelectorAll('input[type="text"]');
    return {
      textareas: Array.from(textareas).map(t => ({ className: t.className?.slice(0, 50), placeholder: t.placeholder?.slice(0, 50) })),
      editables: editables.length,
      inputs: inputs.length,
    };
  });
  console.log('\n输入元素:', JSON.stringify(inputInfo));

  // 尝试输入并发送
  let typed = false;
  if (inputInfo.textareas.length > 0) {
    const ta = page.locator('textarea').first();
    await ta.click();
    await ta.fill('你好');
    typed = true;
    console.log('\n已填写 textarea');
  }

  if (typed) {
    console.log('\n--- 发送消息 ---');
    const preCount = capturedRequests.length;
    await page.keyboard.press('Enter');
    await page.waitForTimeout(10000);

    console.log('\n=== 发送后的关键请求 ===');
    for (const req of capturedRequests.slice(preCount)) {
      if (req.url.includes('stream') || req.url.includes('chat') || req.url.includes('token')) {
        const resp = capturedResponses.get(req.requestId);
        console.log(`\n${req.method} ${req.url}`);
        console.log(`  Status: ${resp?.status ?? 'pending'}`);
        // 打印所有 header
        for (const [k, v] of Object.entries(req.headers)) {
          if (/^(authorization|cookie|x-|app-|content-type|accept)/i.test(k)) {
            console.log(`  ${k}: ${String(v).slice(0, 200)}`);
          }
        }
        // 获取响应体
        if (resp) {
          try {
            const body = await cdpSession.send('Network.getResponseBody', { requestId: req.requestId });
            console.log(`  Response: ${body.body?.slice(0, 500)}`);
          } catch { /* streaming response */ }
        }
      }
    }
  }

  await page.close();
  browser.close();
}

main().catch(e => console.error(e.message));
