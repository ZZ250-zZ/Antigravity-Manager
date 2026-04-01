#!/usr/bin/env node
/**
 * 通过 CDP 抓取讯飞星火的 Web 聊天 API - 先处理弹窗
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  console.log('=== Spark API 抓取 v3 ===\n');
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];

  let page = context.pages().find(p => p.url().includes('xinghuo.xfyun.cn'));
  let needClose = false;
  if (!page) {
    page = await context.newPage();
    needClose = true;
    await page.goto('https://xinghuo.xfyun.cn/desk', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
  }
  console.log('页面 URL:', page.url());

  // 处理同意弹窗
  try {
    const checkbox = await page.$('.ant-checkbox-input');
    if (checkbox) {
      await checkbox.click();
      console.log('✅ 已勾选同意协议');
      await page.waitForTimeout(500);
    }
    const agreeBtn = await page.$('button.ant-btn-primary');
    if (agreeBtn) {
      const text = await agreeBtn.textContent();
      if (text?.includes('同意')) {
        await agreeBtn.click();
        console.log('✅ 已点击同意体验');
        await page.waitForTimeout(3000);
      }
    }
  } catch (e) {
    console.log('弹窗处理:', e.message.slice(0, 80));
  }

  // CDP 抓包
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Network.enable');

  const captured = [];
  cdpSession.on('Network.requestWillBeSent', (params) => {
    const url = params.request.url;
    if (url.includes('xfyun.cn') && !url.endsWith('.js') && !url.endsWith('.css') &&
        !url.includes('.png') && !url.includes('.svg') && !url.includes('.woff') &&
        !url.includes('.ico') && !url.includes('/track') && !url.includes('/log')) {
      captured.push({
        url,
        method: params.request.method,
        headers: params.request.headers,
        body: params.request.postData?.slice(0, 1000),
        requestId: params.requestId,
      });
      console.log(`📡 [${params.request.method}] ${url}`);
      if (params.request.postData) {
        console.log(`   Body: ${params.request.postData.slice(0, 400)}`);
      }
    }
  });

  cdpSession.on('Network.responseReceived', (params) => {
    const url = params.response.url;
    if (url.includes('xfyun.cn') && !url.endsWith('.js') && !url.endsWith('.css') &&
        !url.includes('.png') && !url.includes('.svg')) {
      console.log(`   ← ${params.response.status} ${url.split('?')[0]}`);
    }
  });

  // 分析页面结构（弹窗关闭后）
  const pageInfo = await page.evaluate(() => {
    const textareas = document.querySelectorAll('textarea');
    const editables = document.querySelectorAll('[contenteditable="true"]');
    const divInputs = document.querySelectorAll('[class*="input"], [class*="Input"], [class*="editor"], [class*="Editor"]');
    return {
      textareas: Array.from(textareas).map(el => ({
        id: el.id, class: el.className?.slice(0, 80), placeholder: el.placeholder
      })),
      editables: Array.from(editables).map(el => ({
        id: el.id, class: el.className?.slice(0, 80), tag: el.tagName
      })),
      divInputs: Array.from(divInputs).slice(0, 10).map(el => ({
        tag: el.tagName, class: el.className?.toString()?.slice(0, 80), role: el.getAttribute('role')
      })),
    };
  });
  
  console.log('\n页面元素分析:');
  console.log('Textareas:', JSON.stringify(pageInfo.textareas, null, 2));
  console.log('Editables:', JSON.stringify(pageInfo.editables, null, 2));
  console.log('DivInputs:', JSON.stringify(pageInfo.divInputs, null, 2));

  // 尝试发送消息
  let sent = false;
  try {
    // 试 textarea
    const textarea = await page.$('textarea');
    if (textarea) {
      await textarea.click();
      await page.waitForTimeout(300);
      await textarea.fill('你好');
      await page.waitForTimeout(300);
      await textarea.press('Enter');
      sent = true;
      console.log('\n✅ 已通过 textarea 发送消息');
    }
  } catch (e) {
    console.log('textarea 操作失败:', e.message.slice(0, 80));
  }

  if (!sent) {
    try {
      const editable = await page.$('[contenteditable="true"]');
      if (editable) {
        await editable.click();
        await page.waitForTimeout(300);
        await editable.fill('你好');
        await page.waitForTimeout(300);
        await editable.press('Enter');
        sent = true;
        console.log('\n✅ 已通过 contenteditable 发送消息');
      }
    } catch (e) {
      console.log('contenteditable 操作失败:', e.message.slice(0, 80));
    }
  }

  if (!sent) {
    console.log('\n⏳ 无法自动发送，请手动在浏览器 Spark 页面中发送消息...');
  }

  console.log('等待 20 秒抓包...\n');
  await page.waitForTimeout(20000);

  console.log(`\n=== 共抓取 ${captured.length} 个请求 ===`);
  for (const req of captured) {
    console.log(`\n--- ${req.method} ${req.url} ---`);
    console.log('Headers:', JSON.stringify(Object.fromEntries(
      Object.entries(req.headers).filter(([k]) => !['user-agent','sec-ch-ua','sec-fetch-dest','sec-fetch-mode','sec-fetch-site','accept-language','accept-encoding','dnt','connection'].includes(k.toLowerCase()))
    ), null, 2));
    if (req.body) console.log('Body:', req.body);
  }

  browser.close();
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
