/**
 * 自动化 API 捕获脚本
 * 通过 Playwright 控制浏览器，自动发送消息并捕获 API 请求
 */
import { chromium } from 'playwright';

const target = process.argv[2] || 'zhipu';

async function main() {
  console.log(`=== 自动捕获 ${target} API 请求 ===\n`);
  
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  if (!context) { console.log('❌ 未连接到浏览器'); return; }

  const captured = [];
  
  // 监听网络请求
  context.on('request', async (request) => {
    const url = request.url();
    const method = request.method();
    if (method !== 'POST' && method !== 'GET') return;
    
    // 过滤相关请求
    const patterns = {
      zhipu: ['chatglm.cn/chatglm', 'chatglm.cn/trpc'],
      doubao: ['doubao.com/samantha', 'doubao.com/alice', 'doubao.com/api'],
    };
    const p = patterns[target] || [];
    if (!p.some(pat => url.includes(pat))) return;

    const headers = request.headers();
    const postData = request.postData();
    
    const entry = { method, url, headers: {}, body: null };
    
    // 提取关键 headers
    const importantKeys = ['authorization', 'cookie', 'content-type', 'x-sign', 'x-nonce', 
      'x-timestamp', 'x-device-id', 'x-request-id', 'app-name', 'platform',
      'x-msh-platform', 'x-traffic-id', 'agw-js-conv', 'x-flow-trace', 'referer', 'origin',
      'x-app-id', 'x-browser-id', 'accept'];
    for (const k of importantKeys) {
      if (headers[k]) {
        // Cookie 只保留名称列表
        if (k === 'cookie') {
          entry.headers[k] = headers[k].split(';').map(c => c.trim().split('=')[0]).join(', ');
        } else {
          entry.headers[k] = headers[k].length > 200 ? headers[k].slice(0, 200) + '...' : headers[k];
        }
      }
    }
    
    if (postData) {
      try { entry.body = JSON.parse(postData); } catch(e) { entry.body = postData.slice(0, 500); }
    }
    
    captured.push(entry);
    console.log(`[捕获] ${method} ${url.slice(0, 100)}`);
  });

  context.on('response', async (response) => {
    const url = response.url();
    const patterns = {
      zhipu: ['chatglm.cn/chatglm', 'chatglm.cn/trpc'],
      doubao: ['doubao.com/samantha', 'doubao.com/alice', 'doubao.com/api'],
    };
    const p = patterns[target] || [];
    if (!p.some(pat => url.includes(pat))) return;

    const status = response.status();
    const ct = response.headers()['content-type'] || '';
    console.log(`[响应] ${status} ${ct.slice(0, 50)} ${url.slice(0, 80)}`);
    
    // 非 SSE 响应尝试获取 body
    if (!ct.includes('event-stream') && !ct.includes('octet-stream')) {
      try {
        const body = await response.text();
        if (body.length < 2000) {
          console.log(`  Body: ${body.slice(0, 500)}`);
        } else {
          console.log(`  Body (${body.length} chars): ${body.slice(0, 300)}...`);
        }
      } catch(e) {}
    }
  });

  // 打开目标页面
  const page = await context.newPage();
  
  if (target === 'zhipu') {
    console.log('导航到智谱清言...');
    await page.goto('https://chatglm.cn/main/alltoolsdetail', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    
    // 尝试找到输入框并发送消息
    console.log('尝试发送消息...');
    
    // 打印页面结构来定位输入框
    const inputs = await page.evaluate(() => {
      const elements = [];
      document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]').forEach(el => {
        elements.push({
          tag: el.tagName,
          type: el.type,
          placeholder: el.placeholder,
          className: el.className?.slice(0, 100),
          id: el.id,
          role: el.getAttribute('role'),
        });
      });
      return elements;
    });
    console.log('找到的输入元素:', JSON.stringify(inputs, null, 2));
    
    // 尝试通过不同选择器找到输入框
    const selectors = [
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]',
      'input[type="text"]',
      '.input-box textarea',
      '#search-input-box textarea',
    ];
    
    let inputFound = false;
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          await page.waitForTimeout(500);
          await el.fill('你好，一句话介绍自己');
          await page.waitForTimeout(500);
          // 按 Enter 发送
          await page.keyboard.press('Enter');
          console.log(`✅ 使用 ${sel} 发送了消息`);
          inputFound = true;
          break;
        }
      } catch(e) {
        console.log(`  ${sel}: ${e.message.slice(0, 80)}`);
      }
    }
    
    if (!inputFound) {
      console.log('⚠️ 未找到输入框，请手动在浏览器中发送消息');
    }
    
  } else if (target === 'doubao') {
    console.log('导航到豆包...');
    await page.goto('https://www.doubao.com/chat/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    
    // 打印页面结构
    const inputs = await page.evaluate(() => {
      const elements = [];
      document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [role="textbox"], [data-testid]').forEach(el => {
        elements.push({
          tag: el.tagName,
          type: el.type,
          placeholder: el.placeholder,
          className: el.className?.slice(0, 100),
          id: el.id,
          role: el.getAttribute('role'),
          testid: el.getAttribute('data-testid'),
        });
      });
      return elements;
    });
    console.log('找到的输入元素:', JSON.stringify(inputs, null, 2));
    
    const selectors = [
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]',
      '#chat-input',
      '[data-testid="chat-input"]',
    ];
    
    let inputFound = false;
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          await page.waitForTimeout(500);
          await el.fill('你好，一句话介绍自己');
          await page.waitForTimeout(500);
          await page.keyboard.press('Enter');
          console.log(`✅ 使用 ${sel} 发送了消息`);
          inputFound = true;
          break;
        }
      } catch(e) {
        console.log(`  ${sel}: ${e.message.slice(0, 80)}`);
      }
    }
    
    if (!inputFound) {
      console.log('⚠️ 未找到输入框，请手动在浏览器中发送消息');
    }
  }

  // 等待响应
  console.log('\n等待 API 响应 (30秒)...');
  await page.waitForTimeout(30000);

  // 输出结果
  console.log(`\n\n========== 捕获结果 (共 ${captured.length} 个请求) ==========\n`);
  for (let i = 0; i < captured.length; i++) {
    const c = captured[i];
    console.log(`\n--- 请求 #${i + 1} ---`);
    console.log(`${c.method} ${c.url}`);
    console.log('Headers:', JSON.stringify(c.headers, null, 2));
    if (c.body) {
      console.log('Body:', typeof c.body === 'string' ? c.body : JSON.stringify(c.body, null, 2).slice(0, 1000));
    }
  }

  await page.close().catch(() => {});
  // 不关闭浏览器，避免挂起
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
