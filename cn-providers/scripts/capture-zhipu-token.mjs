#!/usr/bin/env node
/**
 * 通过 CDP 拦截智谱浏览器实际使用的 Authorization token
 */
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await ctx.newPage();

const cdp = await page.context().newCDPSession(page);
await cdp.send('Network.enable');

let capturedToken = '';
cdp.on('Network.requestWillBeSentExtraInfo', (params) => {
  const auth = params.headers['authorization'] || params.headers['Authorization'];
  if (auth && params.headers[':path']?.includes('backend-api')) {
    capturedToken = auth;
    console.log('Captured auth for:', params.headers[':path']?.slice(0, 80));
    console.log('Token:', auth.slice(0, 80) + '...');
  }
});

await page.goto('https://chatglm.cn/main/chatfree', { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForTimeout(3000);

// 发送一条消息来触发 stream API
const textarea = await page.$('textarea');
if (textarea) {
  await textarea.fill('测试');
  await page.waitForTimeout(500);
  await textarea.press('Enter');
  console.log('Sent message');
  await page.waitForTimeout(8000);
} else {
  console.log('No textarea found');
}

if (capturedToken) {
  const token = capturedToken.replace('Bearer ', '');
  
  // 测试这个 token 是否能用于 httpRequest
  const { httpRequest } = await import('../src/http-client.mjs');
  console.log('\nTesting captured token with httpRequest...');
  const res = await httpRequest('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
    method: 'POST',
    headers: {
      Authorization: capturedToken,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Origin: 'https://chatglm.cn',
      Referer: 'https://chatglm.cn/main/chatfree',
    },
    body: JSON.stringify({
      assistant_id: '65940acff94777010aa6b796',
      conversation_id: '',
      project_id: '',
      chat_type: 'user_chat',
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
      meta_data: { is_networking: false, input_question_type: 'xxxx', is_test: false, platform: 'pc' },
    }),
  });
  const text = await res.text();
  console.log('Status:', res.status);
  console.log('Response:', text.slice(0, 500));
} else {
  console.log('No token captured');
}

await page.close();
browser.close();
