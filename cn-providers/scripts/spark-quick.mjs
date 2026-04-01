#!/usr/bin/env node
/**
 * 快速 Spark API 检查（最简单的 CDP 使用）
 */
import { chromium } from 'playwright';

async function main() {
  console.log('连接 CDP...');
  const browser = await chromium.connectOverCDP('http://localhost:9222', { timeout: 15000 });
  console.log('已连接');
  
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  
  try {
    console.log('导航到 Spark...');
    const resp = await page.goto('https://xinghuo.xfyun.cn/desk', { 
      waitUntil: 'domcontentloaded', 
      timeout: 20000 
    });
    console.log('Status:', resp?.status());
    console.log('URL:', page.url());
    
    await page.waitForTimeout(3000);
    
    // 获取页面状态
    const info = await page.evaluate(() => ({
      title: document.title,
      textareas: document.querySelectorAll('textarea').length,
      hasLogin: document.body?.innerText?.includes('登录') && !document.body?.innerText?.includes('退出登录'),
    }));
    console.log('Title:', info.title);
    console.log('Textareas:', info.textareas);
    console.log('Needs login:', info.hasLogin);
    
    // 检查 gee-captcha 响应
    const geeCaptcha = await page.evaluate(async () => {
      try {
        const r = await fetch('/iflygpt/chat/gee-captcha');
        return { status: r.status, body: await r.text() };
      } catch (e) {
        return { error: e.message };
      }
    });
    console.log('\nGeeTest captcha API:', JSON.stringify(geeCaptcha).slice(0, 500));
    
    // 检查 send_text API 是否还存在
    const sendTextCheck = await page.evaluate(async () => {
      try {
        const r = await fetch('/iflygpt-chat/u/chat/send_text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        return { status: r.status, body: (await r.text()).slice(0, 300) };
      } catch (e) {
        return { error: e.message };
      }
    });
    console.log('Old send_text API:', JSON.stringify(sendTextCheck).slice(0, 300));
    
    // 检查新 API 端点
    const chatListV2 = await page.evaluate(async () => {
      try {
        const r = await fetch('/iflygpt/u/chat-list/v2/chat-list', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pageNum: 1, pageSize: 10 }),
        });
        return { status: r.status, body: (await r.text()).slice(0, 500) };
      } catch (e) {
        return { error: e.message };
      }
    });
    console.log('Chat list v2:', JSON.stringify(chatListV2).slice(0, 500));
    
    // 检查新的发送 API
    const sendV2 = await page.evaluate(async () => {
      try {
        const r = await fetch('/iflygpt/u/chat/send-text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        return { status: r.status, body: (await r.text()).slice(0, 300) };
      } catch (e) {
        return { error: e.message };
      }
    });
    console.log('New send-text API:', JSON.stringify(sendV2).slice(0, 300));
    
  } finally {
    await page.close();
    browser.close();
  }
}

main().catch(e => console.error('Error:', e.message));
