#!/usr/bin/env node
/**
 * 捕获智谱 Web 的实际 API 请求
 */
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await ctx.newPage();

const apiCalls = [];
page.on('request', req => {
  const url = req.url();
  if (url.includes('chatglm') && url.includes('api/')) {
    const h = req.headers();
    apiCalls.push({
      method: req.method(),
      url: url.replace('https://chatglm.cn', ''),
      auth: h['authorization']?.slice(0, 30) || 'none',
      contentType: h['content-type'] || '',
      body: req.postData()?.slice(0, 300) || '',
    });
  }
});

page.on('response', async resp => {
  const url = resp.url();
  if (url.includes('chatglm') && (url.includes('stream') || url.includes('refresh') || url.includes('conversation'))) {
    let body = '';
    try { body = (await resp.text()).slice(0, 500); } catch {}
    console.log(`[RESP ${resp.status()}] ${url.replace('https://chatglm.cn', '')}`);
    if (body) console.log('  Body:', body.slice(0, 300));
  }
});

await page.goto('https://chatglm.cn/main/alltoolsdetail?lang=zh', { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForTimeout(3000);

// 导航到聊天页面
await page.goto('https://chatglm.cn/main/chatfree', { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForTimeout(3000);
console.log('Page URL:', page.url());

// 找到输入框并发送消息
const textarea = await page.$('textarea');
if (textarea) {
  await textarea.fill('你好');
  await page.waitForTimeout(500);
  await textarea.press('Enter');
  console.log('Message sent');
  await page.waitForTimeout(8000);
} else {
  // 尝试其他选择器
  const editable = await page.$('[contenteditable="true"]');
  if (editable) {
    await editable.click();
    await page.keyboard.type('你好');
    await page.keyboard.press('Enter');
    console.log('Message sent via contenteditable');
    await page.waitForTimeout(8000);
  } else {
    console.log('No input found');
  }
}

console.log('\n=== API Calls ===');
for (const c of apiCalls) {
  console.log(`${c.method} ${c.url.slice(0, 100)}`);
  console.log(`  auth: ${c.auth}, body: ${c.body.slice(0, 200)}`);
}

await page.close();
browser.close();
