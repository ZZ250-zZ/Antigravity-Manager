#!/usr/bin/env node
/**
 * 自动打开 Spark 聊天页面，等待页面完全加载，然后拦截 API
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  console.log('=== Spark 自动捕获 ===\n');
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];

  // 打开 Spark 聊天页面
  const page = await context.newPage();
  
  // 设置 CDP 监听（在导航前）
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Network.enable');

  const allRequests = [];
  
  cdpSession.on('Network.requestWillBeSent', (params) => {
    const url = params.request.url;
    if (url.includes('xfyun.cn') && !url.endsWith('.js') && !url.endsWith('.css') &&
        !url.includes('.png') && !url.includes('.svg') && !url.includes('.woff') &&
        !url.includes('.ico') && !url.includes('.jpg') && !url.includes('/track') &&
        !url.includes('itm.js') && !url.includes('datacollect') && !url.includes('daas-')) {
      allRequests.push({
        url,
        method: params.request.method,
        body: params.request.postData,
        contentType: params.request.headers['Content-Type'] || params.request.headers['content-type'],
      });
    }
  });

  cdpSession.on('Network.responseReceived', (params) => {
    const url = params.response.url;
    if (url.includes('xfyun.cn') && (url.includes('chat_message') || url.includes('/send') || url.includes('/completions'))) {
      console.log(`📡 ← ${params.response.status} ${url} [${params.response.headers['content-type'] || ''}]`);
    }
  });

  // 导航到 /chat
  console.log('导航到 /chat...');
  try {
    await page.goto('https://xinghuo.xfyun.cn/chat', { 
      waitUntil: 'load',
      timeout: 30000 
    });
  } catch (e) {
    console.log('导航超时，继续...');
  }
  
  // 多等几秒让 SPA 渲染完成
  await page.waitForTimeout(8000);
  
  console.log('当前 URL:', page.url());

  // 检查是否需要同意条款
  try {
    const agreeBtn = await page.$('button:has-text("同意")');
    if (agreeBtn) {
      const checkbox = await page.$('.ant-checkbox-input');
      if (checkbox) await checkbox.click();
      await page.waitForTimeout(300);
      await agreeBtn.click();
      console.log('✅ 已同意条款');
      await page.waitForTimeout(5000);
    }
  } catch { /* ok */ }

  console.log('当前 URL:', page.url());

  // 如果被重定向到首页，尝试点击"立即对话"
  if (!page.url().includes('/chat')) {
    try {
      // 寻找"立即对话"链接
      const chatLink = await page.$('a:has-text("立即对话")');
      if (chatLink) {
        // 使用 JavaScript 导航而不是点击（避免新标签页）
        const href = await chatLink.getAttribute('href');
        console.log('找到聊天入口:', href);
        if (href) {
          await page.goto(href.startsWith('http') ? href : `https://xinghuo.xfyun.cn${href}`, {
            waitUntil: 'load',
            timeout: 30000,
          }).catch(() => {});
          await page.waitForTimeout(5000);
        }
      }
    } catch (e) {
      console.log('导航到聊天页面失败:', e.message.slice(0, 80));
    }
  }

  console.log('最终 URL:', page.url());

  // 分析页面结构
  try {
    const structure = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      textareas: document.querySelectorAll('textarea').length,
      editables: document.querySelectorAll('[contenteditable="true"]').length,
      iframes: Array.from(document.querySelectorAll('iframe')).map(f => f.src?.slice(0, 80)),
      bodyText: document.body?.innerText?.slice(0, 200),
    }));
    console.log('页面结构:', JSON.stringify(structure, null, 2));
  } catch (e) {
    console.log('无法获取页面结构:', e.message.slice(0, 80));
  }

  // 等待用户操作或尝试自动发送
  console.log('\n⏳ 等待 30 秒，请在浏览器 Spark 页面手动发送一条消息...\n');
  await page.waitForTimeout(30000);

  // 分析捕获的请求
  console.log(`\n=== 共 ${allRequests.length} 个请求 ===`);
  
  // 筛选出聊天相关的请求
  const chatReqs = allRequests.filter(r => 
    r.url.includes('chat_message') || r.url.includes('/send') || 
    r.url.includes('/completions') || r.url.includes('csend') ||
    r.url.includes('chat/create') || r.url.includes('chat-list/create')
  );
  
  if (chatReqs.length > 0) {
    console.log(`\n聊天 API 请求:`);
    for (const req of chatReqs) {
      console.log(`\n  [${req.method}] ${req.url}`);
      console.log(`  Content-Type: ${req.contentType}`);
      if (req.body) console.log(`  Body: ${req.body.slice(0, 500)}`);
    }
  } else {
    console.log('\n没有捕获到聊天请求');
    // 打印所有请求路径供分析
    console.log('\n所有请求路径:');
    const seen = new Set();
    for (const req of allRequests) {
      const path = new URL(req.url).pathname;
      if (!seen.has(path)) {
        seen.add(path);
        console.log(`  [${req.method}] ${path}`);
      }
    }
  }

  await page.close();
  browser.close();
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
