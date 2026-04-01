#!/usr/bin/env node
/**
 * 通过 CDP 抓取讯飞星火的 Web 聊天 API 请求 - 更广泛的抓包
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  console.log('=== Spark API 抓取 v2 ===\n');
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];

  // 查找或打开 Spark 页面
  let page = context.pages().find(p => p.url().includes('xinghuo.xfyun.cn'));
  let needClose = false;
  if (!page) {
    page = await context.newPage();
    needClose = true;
    await page.goto('https://xinghuo.xfyun.cn/desk', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
  }
  console.log('页面 URL:', page.url());

  // 分析页面结构
  const pageInfo = await page.evaluate(() => {
    const textareas = document.querySelectorAll('textarea');
    const editables = document.querySelectorAll('[contenteditable="true"]');
    const inputs = document.querySelectorAll('input');
    const buttons = document.querySelectorAll('button');
    const iframes = document.querySelectorAll('iframe');
    
    return {
      textareas: Array.from(textareas).map(el => ({
        id: el.id, class: el.className, placeholder: el.placeholder
      })),
      editables: Array.from(editables).map(el => ({
        id: el.id, class: el.className, tag: el.tagName
      })),
      inputs: Array.from(inputs).map(el => ({
        id: el.id, class: el.className, type: el.type, placeholder: el.placeholder
      })),
      buttons: Array.from(buttons).map(el => ({
        id: el.id, class: el.className, text: el.textContent?.slice(0, 50)
      })).slice(0, 20),
      iframes: Array.from(iframes).map(el => ({
        src: el.src, id: el.id
      })),
      title: document.title,
      url: window.location.href,
    };
  });
  
  console.log('\n页面标题:', pageInfo.title);
  console.log('Textareas:', JSON.stringify(pageInfo.textareas, null, 2));
  console.log('Editables:', JSON.stringify(pageInfo.editables, null, 2));
  console.log('Inputs:', JSON.stringify(pageInfo.inputs.slice(0, 5), null, 2));
  console.log('Buttons (前10):', JSON.stringify(pageInfo.buttons.slice(0, 10), null, 2));
  console.log('Iframes:', JSON.stringify(pageInfo.iframes, null, 2));

  // 广泛抓包 - 抓所有 xfyun.cn 相关的请求
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Network.enable');

  const captured = [];
  cdpSession.on('Network.requestWillBeSent', (params) => {
    const url = params.request.url;
    if (url.includes('xfyun.cn') && !url.includes('.js') && !url.includes('.css') && !url.includes('.png') && !url.includes('.svg') && !url.includes('.woff')) {
      captured.push({
        url,
        method: params.request.method,
        headers: params.request.headers,
        body: params.request.postData?.slice(0, 500),
      });
      console.log(`\n📡 [${params.request.method}] ${url}`);
      if (params.request.postData) {
        console.log(`   Body: ${params.request.postData.slice(0, 300)}`);
      }
    }
  });

  cdpSession.on('Network.responseReceived', (params) => {
    const url = params.response.url;
    if (url.includes('xfyun.cn') && !url.includes('.js') && !url.includes('.css') && !url.includes('.png') && !url.includes('.svg')) {
      console.log(`   ← Status: ${params.response.status} ${url.split('?')[0].split('/').slice(-3).join('/')}`);
    }
  });

  // 尝试用页面 JS 发送消息
  console.log('\n尝试通过页面 DOM 发送消息...');
  
  // 先找所有可能的输入区域
  const allElements = await page.evaluate(() => {
    // 查看所有带 role 的元素
    const roles = document.querySelectorAll('[role]');
    return Array.from(roles).map(el => ({
      role: el.getAttribute('role'),
      tag: el.tagName,
      class: el.className?.toString()?.slice(0, 60),
      text: el.textContent?.slice(0, 30),
    })).slice(0, 30);
  });
  console.log('带 role 的元素:', JSON.stringify(allElements.slice(0, 10), null, 2));

  // 等用户手动发消息
  console.log('\n⏳ 请在浏览器 Spark 页面中手动发送一条消息...');
  console.log('   等待 30 秒...\n');
  await page.waitForTimeout(30000);

  console.log(`\n=== 共抓取 ${captured.length} 个 API 请求 ===`);
  for (const req of captured) {
    console.log(`\n${req.method} ${req.url}`);
    if (req.body) console.log('Body:', req.body);
  }

  browser.close();
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
