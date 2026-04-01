#!/usr/bin/env node
/**
 * 自动在 Metaso 输入搜索并捕获实际 API 请求
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const page = await context.newPage();
  const cdpSession = await page.context().newCDPSession(page);

  // 用 Network domain 拦截（不阻塞请求）
  await cdpSession.send('Network.enable');

  const capturedRequests = [];
  const capturedResponses = new Map();

  cdpSession.on('Network.requestWillBeSent', (params) => {
    const url = params.request.url;
    // 过滤静态资源
    if (/\.(js|css|png|jpg|svg|ico|woff|ttf|eot|webp|gif)(\?|$)/i.test(url)) return;
    if (url.includes('cdn.metaso.cn')) return;

    capturedRequests.push({
      requestId: params.requestId,
      url,
      method: params.request.method,
      headers: params.request.headers,
      postData: params.request.postData || null,
      timestamp: params.timestamp,
    });
    console.log(`[REQ] ${params.request.method} ${url}`);
    if (params.request.postData) {
      console.log(`  Body: ${params.request.postData.slice(0, 500)}`);
    }
  });

  cdpSession.on('Network.responseReceived', (params) => {
    capturedResponses.set(params.requestId, {
      status: params.response.status,
      headers: params.response.headers,
      mimeType: params.response.mimeType,
    });
  });

  console.log('导航到 metaso.cn ...');
  await page.goto('https://metaso.cn/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  console.log('当前URL:', page.url());

  // 查找输入框
  const inputInfo = await page.evaluate(() => {
    const textareas = document.querySelectorAll('textarea');
    const editables = document.querySelectorAll('[contenteditable="true"]');
    const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
    return {
      textareas: textareas.length,
      editables: editables.length,
      inputs: inputs.length,
      firstTextarea: textareas[0]?.className || null,
      firstEditable: editables[0]?.tagName || null,
      firstInput: inputs[0]?.className || null,
    };
  });
  console.log('页面输入元素:', JSON.stringify(inputInfo));

  // 尝试输入并发送
  let typed = false;

  if (inputInfo.textareas > 0) {
    const textarea = page.locator('textarea').first();
    await textarea.click();
    await textarea.fill('你好，请介绍一下自己');
    typed = true;
    console.log('已填写 textarea');
  } else if (inputInfo.editables > 0) {
    const editable = page.locator('[contenteditable="true"]').first();
    await editable.click();
    await editable.type('你好，请介绍一下自己');
    typed = true;
    console.log('已填写 contenteditable');
  } else if (inputInfo.inputs > 0) {
    const input = page.locator('input[type="text"], input:not([type])').first();
    await input.click();
    await input.fill('你好，请介绍一下自己');
    typed = true;
    console.log('已填写 input');
  }

  if (typed) {
    // 清空之前的请求记录，只关注发送后的请求
    const preCount = capturedRequests.length;
    console.log('\n--- 发送搜索 (按 Enter) ---');
    await page.keyboard.press('Enter');

    // 等待请求
    await page.waitForTimeout(15000);

    console.log('\n=== 发送搜索后的请求 ===');
    const newRequests = capturedRequests.slice(preCount);
    for (const req of newRequests) {
      const resp = capturedResponses.get(req.requestId);
      console.log(`\n${req.method} ${req.url}`);
      console.log(`  Status: ${resp?.status ?? 'pending'}`);
      console.log(`  MimeType: ${resp?.mimeType ?? 'unknown'}`);
      if (req.postData) {
        console.log(`  Body: ${req.postData.slice(0, 500)}`);
      }
      // 打印关键 headers
      for (const [k, v] of Object.entries(req.headers)) {
        if (/^(content-type|accept|cookie|authorization|x-|rsc)/i.test(k)) {
          console.log(`  ${k}: ${String(v).slice(0, 200)}`);
        }
      }

      // 尝试获取响应体（对流式响应可能拿不到完整的）
      if (resp && (resp.mimeType?.includes('text') || resp.mimeType?.includes('json') || resp.mimeType?.includes('octet'))) {
        try {
          const body = await cdpSession.send('Network.getResponseBody', { requestId: req.requestId });
          const bodyStr = body.body?.slice(0, 1000);
          if (bodyStr) {
            console.log(`  Response (first 1000 chars): ${bodyStr}`);
          }
        } catch { /* ignore */ }
      }
    }
  } else {
    console.log('未找到输入框');
  }

  await page.close();
  browser.close();
}

main().catch(e => console.error(e.message));
