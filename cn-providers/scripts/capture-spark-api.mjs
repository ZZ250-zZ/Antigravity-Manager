#!/usr/bin/env node
/**
 * 通过 CDP 捕获讯飞星火的实际 API 请求
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  
  // 先检查是否已登录
  const cookies = await context.cookies('https://xinghuo.xfyun.cn');
  console.log('=== Spark Cookies ===');
  for (const c of cookies) {
    if (c.name.includes('session') || c.name.includes('token') || c.name.includes('sso') || c.name.includes('uid')) {
      console.log(`  ${c.name}: ${c.value.slice(0, 50)}...`);
    }
  }
  
  const page = await context.newPage();
  
  // 收集网络请求
  const requests = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('xinghuo') || url.includes('xfyun') || url.includes('spark')) {
      const headers = req.headers();
      requests.push({
        method: req.method(),
        url,
        contentType: headers['content-type'],
        hasAuth: !!headers['authorization'] || !!headers['cookie'],
      });
    }
  });
  
  page.on('response', async (resp) => {
    const url = resp.url();
    if ((url.includes('chat') || url.includes('send') || url.includes('completions') || url.includes('api')) && 
        (url.includes('xinghuo') || url.includes('xfyun') || url.includes('spark'))) {
      try {
        const status = resp.status();
        const contentType = resp.headers()['content-type'] || '';
        let body = '';
        if (!contentType.includes('image') && !contentType.includes('font') && !contentType.includes('wasm')) {
          body = await resp.text().catch(() => '');
        }
        console.log(`\n[RESPONSE] ${status} ${resp.request().method()} ${url}`);
        console.log(`  Content-Type: ${contentType}`);
        if (body && body.length < 2000) {
          console.log(`  Body: ${body}`);
        } else if (body) {
          console.log(`  Body (truncated): ${body.slice(0, 500)}`);
        }
      } catch {}
    }
  });
  
  console.log('\n=== 导航到 Spark ===');
  try {
    await page.goto('https://xinghuo.xfyun.cn/desk', { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.log('导航超时，继续...');
  }
  
  await page.waitForTimeout(5000);
  
  // 检查当前 URL
  console.log('\n当前 URL:', page.url());
  
  // 检查页面上的主要元素
  const pageInfo = await page.evaluate(() => {
    const title = document.title;
    // 查找输入框
    const inputs = document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]');
    const inputInfo = Array.from(inputs).map(el => ({
      tag: el.tagName,
      class: el.className?.slice(0, 100),
      placeholder: el.placeholder || '',
      id: el.id,
    }));
    
    // 查找登录相关提示
    const loginHints = [];
    document.querySelectorAll('button, a').forEach(el => {
      const text = el.textContent?.trim();
      if (text && (text.includes('登录') || text.includes('注册') || text.includes('login'))) {
        loginHints.push(text);
      }
    });
    
    return { title, inputInfo, loginHints, bodySnippet: document.body?.innerText?.slice(0, 500) };
  });
  
  console.log('\n页面标题:', pageInfo.title);
  console.log('输入框:', JSON.stringify(pageInfo.inputInfo, null, 2));
  if (pageInfo.loginHints.length > 0) {
    console.log('登录提示:', pageInfo.loginHints);
  }
  console.log('页面内容片段:', pageInfo.bodySnippet?.slice(0, 300));
  
  // 打印捕获的请求
  console.log(`\n=== 捕获 ${requests.length} 个相关请求 ===`);
  for (const req of requests.slice(0, 20)) {
    console.log(`  ${req.method} ${req.url}`);
  }
  
  // 尝试找到并分析 JS 中的 API 端点
  console.log('\n=== 搜索页面 JS 中的 API 端点 ===');
  const apiEndpoints = await page.evaluate(() => {
    const scripts = performance.getEntriesByType('resource')
      .filter(r => r.name.endsWith('.js'))
      .map(r => ({ name: r.name, size: r.transferSize }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 10);
    return scripts;
  });
  
  console.log('JS 文件:');
  for (const s of apiEndpoints) {
    console.log(`  ${s.size} bytes - ${s.name}`);
  }
  
  await page.close();
  browser.close();
}

main().catch(e => console.error(e.message));
