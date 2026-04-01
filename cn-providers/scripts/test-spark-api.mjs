#!/usr/bin/env node
/**
 * 通过浏览器上下文直接测试讯飞星火的 API 端点
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  console.log('=== Spark API 端点测试 ===\n');
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];

  // 找到 Spark 相关的标签页，或者打开新的
  let page = context.pages().find(p => p.url().includes('xinghuo.xfyun.cn'));
  if (!page) {
    page = await context.newPage();
    await page.goto('https://xinghuo.xfyun.cn/desk', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(5000);
  }
  
  // 确保在 xinghuo 域名下
  if (!page.url().includes('xinghuo.xfyun.cn')) {
    await page.goto('https://xinghuo.xfyun.cn/desk', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
  }
  
  console.log('页面 URL:', page.url());

  // 通过浏览器 fetch 测试各种 API 端点
  const testResults = await page.evaluate(async () => {
    const results = [];
    const base = 'https://xinghuo.xfyun.cn';
    
    const commonHeaders = {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/plain, */*',
      'Lang-Code': 'zh',
      'clientType': '1',
    };

    // 1. 检查用户状态
    try {
      const r = await fetch(`${base}/iflygpt/checkUser`, { headers: commonHeaders });
      const d = await r.json();
      results.push({ endpoint: '/iflygpt/checkUser', status: r.status, data: JSON.stringify(d).slice(0, 200) });
    } catch (e) { results.push({ endpoint: '/iflygpt/checkUser', error: e.message }); }

    // 2. 获取用户信息
    try {
      const r = await fetch(`${base}/iflygpt/userInfo`, { headers: commonHeaders });
      const d = await r.json();
      results.push({ endpoint: '/iflygpt/userInfo', status: r.status, data: JSON.stringify(d).slice(0, 200) });
    } catch (e) { results.push({ endpoint: '/iflygpt/userInfo', error: e.message }); }

    // 3. 尝试创建聊天 - 新路径
    const createEndpoints = [
      '/iflygpt/u/chat-list/create',
      '/iflygpt/u/chat-list/v2/create',
      '/iflygpt/u/chat_list/create',
      '/iflygpt-chat/u/chat_list/create',
    ];
    for (const ep of createEndpoints) {
      try {
        const r = await fetch(`${base}${ep}`, {
          method: 'POST',
          headers: commonHeaders,
          body: JSON.stringify({}),
        });
        const text = await r.text();
        results.push({ endpoint: ep, method: 'POST', status: r.status, data: text.slice(0, 200) });
      } catch (e) { results.push({ endpoint: ep, error: e.message }); }
    }

    // 4. 尝试发送消息 - 各种路径
    const sendEndpoints = [
      '/iflygpt/u/chat/send/text',
      '/iflygpt/u/chat/send_text',
      '/iflygpt-chat/u/chat/send_text',
      '/iflygpt/chat/completions',
      '/iflygpt/u/chat/v4/send_text',
    ];
    for (const ep of sendEndpoints) {
      try {
        const r = await fetch(`${base}${ep}`, {
          method: 'POST',
          headers: { ...commonHeaders, Accept: 'text/event-stream' },
          body: JSON.stringify({
            chatListId: 'test-123',
            content: '你好',
            GtToken: '',
            clientType: 1,
          }),
        });
        const text = await r.text();
        results.push({ endpoint: ep, method: 'POST', status: r.status, data: text.slice(0, 300) });
      } catch (e) { results.push({ endpoint: ep, error: e.message }); }
    }

    // 5. 检查 chat_home（可能包含 API 信息）
    try {
      const r = await fetch(`${base}/iflygpt/chat_home/get`, { headers: commonHeaders });
      const d = await r.json();
      results.push({ endpoint: '/iflygpt/chat_home/get', status: r.status, data: JSON.stringify(d).slice(0, 500) });
    } catch (e) { results.push({ endpoint: '/iflygpt/chat_home/get', error: e.message }); }

    // 6. 获取聊天列表（看看结构）
    try {
      const r = await fetch(`${base}/iflygpt/u/chat-list/v2/chat-list`, {
        method: 'POST',
        headers: commonHeaders,
        body: JSON.stringify({ chatType: 1 }),
      });
      const d = await r.json();
      results.push({ endpoint: '/iflygpt/u/chat-list/v2/chat-list', status: r.status, data: JSON.stringify(d).slice(0, 500) });
    } catch (e) { results.push({ endpoint: '/iflygpt/u/chat-list/v2/chat-list', error: e.message }); }

    // 7. gee-captcha
    try {
      const r = await fetch(`${base}/iflygpt/chat/gee-captcha`, { headers: commonHeaders });
      const d = await r.json();
      results.push({ endpoint: '/iflygpt/chat/gee-captcha', status: r.status, data: JSON.stringify(d).slice(0, 200) });
    } catch (e) { results.push({ endpoint: '/iflygpt/chat/gee-captcha', error: e.message }); }

    return results;
  });

  for (const r of testResults) {
    console.log(`\n[${r.method || 'GET'}] ${r.endpoint}`);
    if (r.error) {
      console.log(`  ❌ Error: ${r.error}`);
    } else {
      console.log(`  Status: ${r.status}`);
      console.log(`  Data: ${r.data}`);
    }
  }

  await page.close();
  browser.close();
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
