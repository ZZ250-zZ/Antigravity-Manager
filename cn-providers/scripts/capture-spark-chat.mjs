#!/usr/bin/env node
/**
 * 探索 Spark 的新聊天接口
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  
  // 检查所有可能的域名 cookies
  console.log('=== 检查 Cookies ===');
  for (const domain of ['https://xinghuo.xfyun.cn', 'https://xhspdup.xfyun.cn', 'https://sso.xfyun.cn', 'https://spark.xfyun.cn']) {
    const cookies = await context.cookies(domain);
    if (cookies.length > 0) {
      console.log(`\n${domain}:`);
      for (const c of cookies.slice(0, 10)) {
        const expired = c.expires > 0 && c.expires * 1000 < Date.now();
        console.log(`  ${c.name}: ${c.value.slice(0, 40)}... ${expired ? '[EXPIRED]' : ''}`);
      }
    }
  }
  
  const page = await context.newPage();
  
  // 监控请求
  const chatRequests = [];
  page.on('request', req => {
    const url = req.url();
    if (url.includes('chat') || url.includes('send') || url.includes('completion') || url.includes('desk')) {
      chatRequests.push({
        method: req.method(),
        url,
        headers: req.headers(),
      });
    }
  });
  
  // 尝试导航到 desk
  console.log('\n=== 尝试 /desk ===');
  try {
    await page.goto('https://xinghuo.xfyun.cn/desk', { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch {}
  await page.waitForTimeout(3000);
  console.log('Current URL:', page.url());
  
  const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 300));
  console.log('Page text:', pageText);
  
  // 检查是否需要登录
  const needsLogin = page.url().includes('login') || page.url() === 'https://xinghuo.xfyun.cn/';
  if (needsLogin) {
    console.log('\n需要重新登录！当前 ssoSessionId 可能已过期。');
    
    // 尝试 xhspdup 域名
    console.log('\n=== 尝试 xhspdup.xfyun.cn ===');
    try {
      await page.goto('https://xhspdup.xfyun.cn', { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch {}
    await page.waitForTimeout(3000);
    console.log('Current URL:', page.url());
    const text2 = await page.evaluate(() => document.body?.innerText?.slice(0, 300));
    console.log('Page text:', text2);
  }
  
  // 打印聊天相关请求
  console.log(`\n=== 捕获的 chat 请求 (${chatRequests.length}) ===`);
  for (const r of chatRequests.slice(0, 10)) {
    console.log(`  ${r.method} ${r.url}`);
  }
  
  await page.close();
  browser.close();
}

main().catch(e => console.error(e.message));
