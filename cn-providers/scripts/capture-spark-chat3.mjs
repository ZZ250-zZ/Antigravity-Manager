#!/usr/bin/env node
/**
 * 通过 CDP 抓取讯飞星火聊天 API - 点击"立即对话"进入聊天
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  console.log('=== Spark Chat 抓取 v5 ===\n');
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];

  const page = await context.newPage();
  
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Network.enable');

  const captured = [];
  cdpSession.on('Network.requestWillBeSent', (params) => {
    const url = params.request.url;
    if (url.includes('xfyun.cn') && 
        (url.includes('/iflygpt') || url.includes('/chat') || url.includes('/send') || url.includes('/completions')) &&
        !url.includes('.svg') && !url.includes('.png')) {
      captured.push({
        url,
        method: params.request.method,
        headers: params.request.headers,
        body: params.request.postData?.slice(0, 2000),
        requestId: params.requestId,
      });
      console.log(`📡 [${params.request.method}] ${url.split('?')[0]}`);
      if (params.request.postData) {
        console.log(`   Body: ${params.request.postData.slice(0, 500)}`);
      }
    }
  });

  cdpSession.on('Network.responseReceived', (params) => {
    const url = params.response.url;
    if (url.includes('xfyun.cn') && 
        (url.includes('/iflygpt') || url.includes('/chat') || url.includes('/send') || url.includes('/completions')) &&
        !url.includes('.svg') && !url.includes('.png')) {
      console.log(`   ← ${params.response.status} ${url.split('?')[0]} [${params.response.headers['content-type'] || ''}]`);
    }
  });

  // 先导航到首页
  console.log('导航到 xinghuo.xfyun.cn...');
  await page.goto('https://xinghuo.xfyun.cn/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  console.log('URL:', page.url());

  // 点击"立即对话"
  try {
    const links = await page.$$('a');
    for (const link of links) {
      const text = await link.textContent();
      const href = await link.getAttribute('href');
      if (text?.includes('立即对话') || text?.includes('开始对话')) {
        console.log(`找到入口: "${text.trim()}" → ${href}`);
        await link.click();
        await page.waitForTimeout(5000);
        console.log('导航后 URL:', page.url());
        break;
      }
    }
  } catch (e) {
    console.log(`点击入口失败: ${e.message.slice(0, 80)}`);
  }

  // 如果没跳转，试直接访问 /desk 的子路径
  if (page.url() === 'https://xinghuo.xfyun.cn/') {
    // 尝试 /desk 的不同变体
    const tryUrls = [
      'https://xinghuo.xfyun.cn/desk',
      'https://xinghuo.xfyun.cn/spark',
      'https://xinghuo.xfyun.cn/chat',
    ];
    for (const u of tryUrls) {
      console.log(`\n试: ${u}`);
      await page.goto(u, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
      const finalUrl = page.url();
      console.log('实际 URL:', finalUrl);
      
      // 检查是否有输入框
      const hasInput = await page.evaluate(() => {
        return document.querySelectorAll('textarea, [contenteditable="true"]').length;
      });
      if (hasInput > 0) {
        console.log(`✅ 找到输入框！`);
        break;
      }
    }
  }

  // 分析当前页面
  const pageInfo = await page.evaluate(() => {
    const textareas = document.querySelectorAll('textarea');
    const editables = document.querySelectorAll('[contenteditable="true"]');
    const buttons = document.querySelectorAll('button');
    return {
      url: window.location.href,
      textareas: Array.from(textareas).map(el => ({
        id: el.id, class: el.className?.slice(0, 80), 
        placeholder: el.placeholder,
        visible: el.offsetParent !== null,
      })),
      editables: Array.from(editables).map(el => ({
        id: el.id, class: el.className?.toString()?.slice(0, 80), tag: el.tagName,
      })),
      buttons: Array.from(buttons).slice(0, 15).map(el => ({
        class: el.className?.slice(0, 60), text: el.textContent?.trim()?.slice(0, 30),
      })),
    };
  });
  
  console.log('\n当前页面:', pageInfo.url);
  console.log('Textareas:', JSON.stringify(pageInfo.textareas, null, 2));
  console.log('Editables:', JSON.stringify(pageInfo.editables, null, 2));
  console.log('Buttons:', JSON.stringify(pageInfo.buttons.filter(b => b.text), null, 2));

  // 尝试发送消息
  const textarea = await page.$('#askwindow-textarea') || await page.$('textarea');
  if (textarea) {
    console.log('\n发送消息...');
    await textarea.click({ force: true });
    await page.waitForTimeout(500);
    await page.keyboard.type('你好，用一句话介绍一下量子计算', { delay: 30 });
    await page.waitForTimeout(500);
    
    // 尝试 Ctrl+Enter 或点发送
    const sendBtns = await page.$$('button');
    let clicked = false;
    for (const btn of sendBtns) {
      const cls = await btn.getAttribute('class');
      const text = await btn.textContent();
      if (cls?.includes('send') || cls?.includes('submit') || text?.includes('发送')) {
        await btn.click();
        clicked = true;
        console.log('✅ 点击发送按钮');
        break;
      }
    }
    if (!clicked) {
      await page.keyboard.press('Enter');
      console.log('✅ 按 Enter 发送');
    }

    // 等待响应
    console.log('等待 15 秒...');
    await page.waitForTimeout(15000);
  } else {
    console.log('\n未找到输入框，等待 5 秒...');
    await page.waitForTimeout(5000);
  }

  // 输出关键请求
  const chatReqs = captured.filter(r => 
    r.url.includes('/send') || r.url.includes('/chat') || r.url.includes('/completions') ||
    r.url.includes('create') || r.url.includes('delete')
  );
  
  console.log(`\n=== 聊天相关请求 (${chatReqs.length}/${captured.length}) ===`);
  for (const req of chatReqs) {
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(([k]) => 
        ['cookie', 'content-type', 'accept', 'origin', 'referer', 'x-requested-with',
         'lang-code', 'clienttype', 'authorization', 'referorigin', 'x-token'].includes(k.toLowerCase())
      )
    );
    console.log(`\n--- ${req.method} ${req.url} ---`);
    console.log('Headers:', JSON.stringify(headers, null, 2));
    if (req.body) console.log('Body:', req.body);
  }

  // 也输出所有请求路径
  console.log('\n=== 所有请求路径 ===');
  for (const req of captured) {
    const path = new URL(req.url).pathname;
    console.log(`  [${req.method}] ${path}`);
  }

  await page.close();
  browser.close();
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
