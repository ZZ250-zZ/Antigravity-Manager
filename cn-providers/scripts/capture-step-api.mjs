#!/usr/bin/env node
/**
 * 通过 CDP 捕获 StepChat 的聊天 API 端点和请求格式
 */
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await ctx.newPage();

const chatCalls = [];
page.on('request', req => {
  const url = req.url();
  if (url.includes('chat') || url.includes('completion') || url.includes('message') || url.includes('Chat') || url.includes('Message') || url.includes('Send')) {
    const h = req.headers();
    chatCalls.push({
      type: 'REQ',
      method: req.method(),
      url,
      contentType: h['content-type'] || '',
      hasOasis: !!h['oasis-token'],
      hasAuth: !!h['authorization'],
      postData: req.postData()?.slice(0, 500) || '',
    });
  }
});

page.on('response', async resp => {
  const url = resp.url();
  if ((url.includes('chat') || url.includes('Chat')) && (url.includes('completion') || url.includes('Send') || url.includes('message') || url.includes('Message'))) {
    let body = '';
    try { body = (await resp.text()).slice(0, 500); } catch {}
    chatCalls.push({ type: 'RESP', url, status: resp.status(), contentType: resp.headers()['content-type'] || '', body });
  }
});

await page.goto('https://www.stepfun.com/chats/new', { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForTimeout(3000);

// 输入消息
const textarea = await page.$('textarea');
if (textarea) {
  await textarea.fill('你好');
  console.log('Typed in textarea');
  await page.waitForTimeout(500);
  await textarea.press('Enter');
  console.log('Sent');
} else {
  const editable = await page.$('[contenteditable]');
  if (editable) {
    await editable.click();
    await page.keyboard.type('你好');
    await page.keyboard.press('Enter');
    console.log('Sent via contenteditable');
  } else {
    console.log('No input found');
  }
}

await page.waitForTimeout(10000);

console.log('\n=== Captured Chat API calls ===');
for (const c of chatCalls) {
  console.log(JSON.stringify(c, null, 2));
}

await page.close();
browser.close();
