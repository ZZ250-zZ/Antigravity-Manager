#!/usr/bin/env node
import { chromium } from 'playwright';

const CDP_URL = 'http://127.0.0.1:9222';

async function main() {
  const b = await chromium.connectOverCDP(CDP_URL, { timeout: 60000 });
  const ctx = b.contexts()[0];
  const page = await ctx.newPage();
  
  // 收集 API 请求
  const apiCalls = [];
  page.on('request', req => {
    const url = req.url();
    if (url.includes('iflygpt') || url.includes('gee')) {
      apiCalls.push({ method: req.method(), url, post: req.postData()?.slice(0, 500) });
    }
  });
  
  page.on('response', async resp => {
    const url = resp.url();
    if (url.includes('send') || url.includes('chat_send') || url.includes('gee-captcha')) {
      const body = await resp.text().catch(() => '');
      console.log(`[RESP] ${resp.status()} ${url}`);
      console.log(`  Body: ${body.slice(0, 800)}`);
    }
  });
  
  await page.goto('https://xinghuo.xfyun.cn/desk', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  console.log('URL:', page.url());
  
  // 找输入框
  const textareas = await page.locator('textarea').all();
  console.log('Textareas:', textareas.length);
  
  for (const ta of textareas) {
    const vis = await ta.isVisible();
    const ph = await ta.getAttribute('placeholder');
    console.log(`  visible=${vis} placeholder="${ph}"`);
  }
  
  // 尝试发消息
  const visibleTA = textareas.find(async t => await t.isVisible());
  if (textareas.length > 0) {
    const ta = textareas[0];
    await ta.click();
    await ta.fill('1+1');
    await page.waitForTimeout(500);
    
    // 找发送按钮
    const sendBtns = await page.locator('button').all();
    let sendBtn = null;
    for (const btn of sendBtns) {
      const text = await btn.textContent().catch(() => '');
      const ariaLabel = await btn.getAttribute('aria-label').catch(() => '');
      if (text.includes('发送') || ariaLabel?.includes('send')) {
        sendBtn = btn;
        console.log('找到发送按钮:', text, ariaLabel);
        break;
      }
    }
    
    const countBefore = apiCalls.length;
    
    // 按 Enter 或点击发送
    await page.keyboard.press('Enter');
    await page.waitForTimeout(8000);
    
    const newCalls = apiCalls.slice(countBefore);
    console.log(`\n发送后新增 ${newCalls.length} 个 API 调用:`);
    for (const c of newCalls) {
      console.log(`  ${c.method} ${c.url}`);
      if (c.post) console.log(`    body: ${c.post}`);
    }
  }
  
  await page.close();
  b.close();
}

main().catch(e => console.error(e.message));
