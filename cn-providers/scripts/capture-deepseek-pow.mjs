#!/usr/bin/env node
/**
 * 通过 CDP 抓取浏览器中 DeepSeek 实际发送的 PoW challenge 和 response。
 * 监听 /api/v0/chat/ 开头的请求，捕获 x-ds-pow-response header。
 */

import { chromium } from 'playwright';

const CDP_URL = 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];

  // 找到 DeepSeek 页面或创建一个
  let page = context.pages().find(p => {
    try { return new URL(p.url()).hostname === 'chat.deepseek.com'; } catch { return false; }
  });

  if (!page) {
    page = await context.newPage();
    await page.goto('https://chat.deepseek.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);
  }

  console.log('DeepSeek 页面已就绪:', page.url());
  console.log('\n正在监听网络请求...');
  console.log('请在浏览器中向 DeepSeek 发送一条消息，脚本将捕获 PoW 请求。\n');

  // 监听请求
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/v0/chat/')) {
      console.log(`\n[REQUEST] ${req.method()} ${url}`);
      const headers = req.headers();
      if (headers['x-ds-pow-response']) {
        console.log(`  x-ds-pow-response: ${headers['x-ds-pow-response']}`);
        try {
          const decoded = Buffer.from(headers['x-ds-pow-response'], 'base64').toString();
          console.log(`  解码后: ${decoded}`);
        } catch {}
      }
      // 输出 POST body 的关键字段
      const postData = req.postData();
      if (postData) {
        try {
          const body = JSON.parse(postData);
          console.log(`  请求体关键字段: ${JSON.stringify({
            chat_session_id: body.chat_session_id,
            prompt: body.prompt?.slice(0, 50),
            thinking_enabled: body.thinking_enabled,
          })}`);
        } catch {}
      }
    }
  });

  // 监听响应
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/api/v0/chat/create_pow_challenge')) {
      console.log(`\n[POW CHALLENGE RESPONSE] ${res.status()} ${url}`);
      try {
        const body = await res.json();
        console.log(`  完整数据: ${JSON.stringify(body).slice(0, 800)}`);
      } catch (e) {
        console.log(`  读取失败: ${e.message}`);
      }
    }
    if (url.includes('/api/v0/chat/completion') && !url.includes('pow')) {
      console.log(`\n[COMPLETION RESPONSE] ${res.status()} ${url}`);
      console.log(`  Content-Type: ${res.headers()['content-type']}`);
    }
  });

  // 等待 60 秒让用户操作
  console.log('等待 60 秒...在浏览器中发送 DeepSeek 消息');
  await page.waitForTimeout(60000);

  browser.close();
  console.log('\n完成。');
}

main().catch(console.error);
