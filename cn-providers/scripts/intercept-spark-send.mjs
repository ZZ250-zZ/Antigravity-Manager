#!/usr/bin/env node
/**
 * 通过拦截页面的 XHR/fetch 找到 Spark 的发送 API
 * 在页面中注入钩子，然后通过 UI 发送消息
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];

  // 找到或打开 Spark 页面
  let page = context.pages().find(p => p.url().includes('xinghuo.xfyun.cn'));
  let needClose = false;
  if (!page) {
    page = await context.newPage();
    needClose = true;
  }

  // 方法1: 下载 946 chunk JS 文件直接搜索
  console.log('=== 尝试直接下载 JS chunk ===\n');
  const jsContent = await page.evaluate(async () => {
    // 找到 946 chunk URL
    const scripts = document.querySelectorAll('script[src]');
    let targetUrl = null;
    for (const s of scripts) {
      if (s.src.includes('946.') || s.src.includes('main.')) {
        targetUrl = s.src;
      }
    }
    
    // 尝试直接通过 performance API 找到所有 JS 文件
    const resources = performance.getEntriesByType('resource');
    const jsResources = resources
      .filter(r => r.name.endsWith('.js') && !r.name.includes('vendors'))
      .map(r => r.name);
    
    return { targetUrl, jsResources };
  });
  
  console.log('JS 资源:');
  for (const r of jsContent.jsResources) {
    const name = r.split('/').pop().split('?')[0];
    console.log(`  ${name}: ${r.slice(0, 100)}`);
  }

  // 方法2: 注入 XHR 和 fetch 拦截器
  console.log('\n=== 注入网络拦截器 ===\n');
  await page.evaluate(() => {
    window.__CAPTURED_REQUESTS__ = [];
    
    // 拦截 XMLHttpRequest
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
      this.__method = method;
      this.__url = url;
      return origOpen.apply(this, [method, url, ...args]);
    };
    XMLHttpRequest.prototype.send = function(data) {
      if (this.__url && (this.__url.includes('iflygpt') || this.__url.includes('chat'))) {
        const entry = {
          type: 'XHR',
          method: this.__method,
          url: this.__url,
          data: data instanceof FormData 
            ? Object.fromEntries(data.entries())
            : (typeof data === 'string' ? data.slice(0, 500) : String(data)),
          timestamp: Date.now(),
        };
        window.__CAPTURED_REQUESTS__.push(entry);
        console.log('[XHR CAPTURE]', JSON.stringify(entry));
      }
      return origSend.apply(this, [data]);
    };

    // 拦截 fetch
    const origFetch = window.fetch;
    window.fetch = function(url, options) {
      const urlStr = typeof url === 'string' ? url : url?.url;
      if (urlStr && (urlStr.includes('iflygpt') || urlStr.includes('chat'))) {
        const entry = {
          type: 'fetch',
          method: options?.method || 'GET',
          url: urlStr,
          body: options?.body instanceof FormData
            ? Object.fromEntries(options.body.entries())
            : (typeof options?.body === 'string' ? options.body.slice(0, 500) : undefined),
          timestamp: Date.now(),
        };
        window.__CAPTURED_REQUESTS__.push(entry);
        console.log('[FETCH CAPTURE]', JSON.stringify(entry));
      }
      return origFetch.apply(this, arguments);
    };

    console.log('[Interceptor] 已注入 XHR 和 fetch 拦截器');
  });

  // 导航到聊天页面（如果不在的话）
  const currentUrl = page.url();
  if (!currentUrl.includes('/chat') && !currentUrl.includes('/desk')) {
    await page.goto('https://xinghuo.xfyun.cn/chat', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    // 重新注入拦截器
    await page.evaluate(() => {
      // same injection code...
    });
  }

  // 尝试发送消息
  console.log('\n=== 尝试发送消息 ===\n');
  
  // 等待输入框出现
  let textarea = null;
  for (let i = 0; i < 10; i++) {
    textarea = await page.$('#askwindow-textarea') || await page.$('textarea');
    if (textarea) break;
    await page.waitForTimeout(1000);
  }

  if (textarea) {
    console.log('找到输入框，开始发送...');
    await textarea.click({ force: true });
    await page.waitForTimeout(300);
    await page.keyboard.type('你好', { delay: 50 });
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    console.log('已发送消息');
    await page.waitForTimeout(10000);
  } else {
    console.log('未找到输入框');
    console.log('当前 URL:', page.url());
    // 截图
    await page.screenshot({ path: 'spark-chat-page.png' });
    console.log('已截图: spark-chat-page.png');
  }

  // 收集捕获的请求
  const captured = await page.evaluate(() => window.__CAPTURED_REQUESTS__ || []);
  console.log(`\n=== 捕获了 ${captured.length} 个请求 ===`);
  for (const req of captured) {
    console.log(`\n[${req.type}] ${req.method} ${req.url}`);
    if (req.data) console.log('  Data:', JSON.stringify(req.data).slice(0, 500));
  }

  // 方法3: 直接下载 946 chunk 并搜索
  console.log('\n\n=== 下载 946 chunk ===');
  for (const r of jsContent.jsResources) {
    const name = r.split('/').pop().split('?')[0];
    if (name.startsWith('946.') || name.includes('main.')) {
      console.log(`\n下载: ${name}`);
      try {
        const content = await page.evaluate(async (url) => {
          const res = await fetch(url);
          return await res.text();
        }, r);
        
        // 搜索 chat_message 和 send 相关
        const regex = /["']\/iflygpt-chat\/u\/chat_message[^"']*["']/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
          console.log(`  📌 ${match[0]}`);
          // 上下文
          const start = Math.max(0, match.index - 100);
          const end = Math.min(content.length, match.index + 200);
          console.log(`     ${content.slice(start, end).replace(/\n/g, ' ').slice(0, 300)}`);
        }
        
        // 搜索 EventSource
        if (content.includes('EventSource')) {
          let esIdx = content.indexOf('EventSource');
          while (esIdx !== -1) {
            const ctx = content.slice(Math.max(0, esIdx - 200), esIdx + 300);
            console.log(`\n  🔥 EventSource @${esIdx}:`);
            console.log(`     ${ctx.replace(/\n/g, ' ').slice(0, 400)}`);
            esIdx = content.indexOf('EventSource', esIdx + 1);
          }
        }
        
        // 搜索 FormData append 的字段
        const fdRegex = /\.append\("([^"]+)"/g;
        const fields = new Set();
        while ((match = fdRegex.exec(content)) !== null) {
          fields.add(match[1]);
        }
        if (fields.size > 0) {
          console.log(`\n  FormData 字段: ${[...fields].join(', ')}`);
        }
      } catch (e) {
        console.log(`  错误: ${e.message.slice(0, 80)}`);
      }
    }
  }

  if (needClose) await page.close();
  browser.close();
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
