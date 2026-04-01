#!/usr/bin/env node
/**
 * 使用 CDP 抓取小米 MOMI (aistudio.xiaomimimo.com) 的聊天 API
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
    if (/\.(js|css|png|jpg|svg|ico|woff|ttf|eot|webp|gif|mp4)(\?|$)/i.test(url)) return;
    if (url.includes('google') || url.includes('analytics') || url.includes('cdn.')) return;

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

  console.log('导航到 MOMI...');
  await page.goto('https://aistudio.xiaomimimo.com/#/c', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  console.log('当前URL:', page.url());

  // 收集 cookies
  const cookies = await context.cookies();
  const momiCookies = cookies.filter(c => c.domain.includes('xiaomimimo') || c.domain.includes('xiaomi'));
  console.log('\n=== MOMI Cookies ===');
  for (const c of momiCookies) {
    console.log(`  ${c.name} = ${c.value.slice(0, 40)}... (domain: ${c.domain})`);
  }

  // 收集 localStorage
  const lsData = await page.evaluate(() => {
    const items = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      items[key] = localStorage.getItem(key)?.slice(0, 80);
    }
    return items;
  }).catch(() => ({}));
  console.log('\n=== MOMI localStorage ===');
  for (const [k, v] of Object.entries(lsData)) {
    console.log(`  ${k} = ${v}`);
  }

  // 查找输入框
  const inputInfo = await page.evaluate(() => {
    const textareas = document.querySelectorAll('textarea');
    const editables = document.querySelectorAll('[contenteditable="true"]');
    const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
    return {
      textareas: textareas.length,
      editables: editables.length,
      inputs: inputs.length,
    };
  });
  console.log('\n输入元素:', JSON.stringify(inputInfo));

  // 尝试输入并发送
  const preCount = capturedRequests.length;
  let typed = false;

  if (inputInfo.textareas > 0) {
    const ta = page.locator('textarea').first();
    await ta.click();
    await ta.fill('1+1等于几');
    typed = true;
    console.log('已填写 textarea');
  } else if (inputInfo.editables > 0) {
    const ed = page.locator('[contenteditable="true"]').first();
    await ed.click();
    await ed.type('1+1等于几');
    typed = true;
    console.log('已填写 contenteditable');
  }

  if (typed) {
    console.log('\n--- 按 Enter 发送 ---');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(15000);

    console.log('\n=== 发送后的新请求 ===');
    const newReqs = capturedRequests.slice(preCount);
    for (const req of newReqs) {
      const resp = capturedResponses.get(req.requestId);
      console.log(`\n${req.method} ${req.url}`);
      console.log(`  Status: ${resp?.status ?? 'pending'}`);
      console.log(`  MimeType: ${resp?.mimeType ?? 'unknown'}`);
      if (req.postData) {
        console.log(`  Body: ${req.postData.slice(0, 800)}`);
      }
      for (const [k, v] of Object.entries(req.headers)) {
        if (/^(content-type|accept|cookie|authorization|x-|token)/i.test(k)) {
          console.log(`  ${k}: ${String(v).slice(0, 200)}`);
        }
      }
      // 尝试获取响应体
      if (resp) {
        try {
          const body = await cdpSession.send('Network.getResponseBody', { requestId: req.requestId });
          if (body.body) {
            console.log(`  Response: ${body.body.slice(0, 1000)}`);
          }
        } catch { /* ignore */ }
      }
    }
  } else {
    console.log('未找到输入框，请检查页面是否正常加载');
  }

  await page.close();
  browser.close();
}

main().catch(e => console.error(e.message));
