#!/usr/bin/env node
/**
 * 通过 CDP 抓取讯飞星火 - 尝试多个 URL 找到聊天入口
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  console.log('=== Spark Chat 抓取 v4 ===\n');
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];

  const page = await context.newPage();
  
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Network.enable');

  const captured = [];
  cdpSession.on('Network.requestWillBeSent', (params) => {
    const url = params.request.url;
    if (url.includes('xfyun.cn') && 
        (url.includes('/iflygpt') || url.includes('/chat') || url.includes('/api') || url.includes('/send') || url.includes('/spark'))) {
      captured.push({
        url,
        method: params.request.method,
        headers: params.request.headers,
        body: params.request.postData?.slice(0, 1000),
      });
      console.log(`📡 [${params.request.method}] ${url}`);
      if (params.request.postData) {
        console.log(`   Body: ${params.request.postData.slice(0, 400)}`);
      }
    }
  });

  cdpSession.on('Network.responseReceived', (params) => {
    const url = params.response.url;
    if (url.includes('xfyun.cn') && 
        (url.includes('/iflygpt') || url.includes('/chat') || url.includes('/api') || url.includes('/send') || url.includes('/spark'))) {
      console.log(`   ← ${params.response.status} ${url.split('?')[0]}`);
    }
  });

  // 试多个 URL
  const urls = [
    'https://xinghuo.xfyun.cn/desk',
    'https://xinghuo.xfyun.cn/',
  ];

  for (const url of urls) {
    console.log(`\n--- 尝试 ${url} ---`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    
    console.log('实际 URL:', page.url());
    
    // 处理弹窗
    try {
      const checkbox = await page.$('.ant-checkbox-input');
      if (checkbox) { await checkbox.click(); await page.waitForTimeout(300); }
      const btn = await page.$('button.ant-btn-primary');
      if (btn) {
        const t = await btn.textContent();
        if (t?.includes('同意')) { await btn.click(); await page.waitForTimeout(3000); }
      }
    } catch { /* ok */ }

    // 检查可输入元素
    const inputs = await page.evaluate(() => {
      const all = document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]');
      return Array.from(all).map(el => ({
        tag: el.tagName, id: el.id, 
        class: el.className?.toString()?.slice(0, 80),
        visible: el.offsetParent !== null,
        w: el.getBoundingClientRect().width,
        h: el.getBoundingClientRect().height,
      }));
    });
    
    if (inputs.length > 0) {
      console.log('找到输入元素:', JSON.stringify(inputs, null, 2));
      
      // 尝试发送
      for (const inp of inputs) {
        if (inp.w > 50 && inp.h > 10) {
          const selector = inp.id ? `#${inp.id}` : `${inp.tag.toLowerCase()}.${inp.class?.split(' ')[0] || ''}`;
          console.log(`尝试使用: ${selector}`);
          try {
            const el = await page.$(inp.id ? `#${inp.id}` : inp.tag.toLowerCase());
            if (el) {
              await el.click({ force: true });
              await page.waitForTimeout(300);
              await page.keyboard.type('你好', { delay: 50 });
              await page.waitForTimeout(300);
              
              // 截图看看页面
              await page.screenshot({ path: 'spark-screenshot.png' });
              console.log('已截图: spark-screenshot.png');
              
              await page.keyboard.press('Enter');
              console.log('已按 Enter');
              await page.waitForTimeout(15000);
              break;
            }
          } catch (e) {
            console.log(`操作失败: ${e.message.slice(0, 80)}`);
          }
        }
      }
    } else {
      console.log('没有找到输入元素');
      // 截图
      await page.screenshot({ path: 'spark-screenshot.png' });
      console.log('已截图: spark-screenshot.png');
      
      // 查看页面主要内容
      const bodyText = await page.evaluate(() => {
        return document.body?.innerText?.slice(0, 500);
      });
      console.log('页面文本:', bodyText?.slice(0, 300));
    }
  }

  console.log(`\n=== 共抓取 ${captured.length} 个 API 请求 ===`);
  for (const req of captured) {
    console.log(`\n${req.method} ${req.url}`);
    if (req.body) console.log('Body:', req.body);
  }

  await page.close();
  browser.close();
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
