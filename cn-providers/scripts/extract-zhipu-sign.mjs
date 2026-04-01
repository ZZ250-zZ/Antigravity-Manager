#!/usr/bin/env node
/**
 * 通过 hook XMLHttpRequest 来捕获 Zhipu 签名
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  
  const page = await context.newPage();
  
  // 在页面加载前 hook XHR
  await page.addInitScript(() => {
    window._capturedXhrHeaders = [];
    const origOpen = XMLHttpRequest.prototype.open;
    const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const origSend = XMLHttpRequest.prototype.send;
    
    XMLHttpRequest.prototype.open = function(method, url) {
      this._url = url;
      this._method = method;
      this._headers = {};
      return origOpen.apply(this, arguments);
    };
    
    XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
      this._headers[name] = value;
      return origSetRequestHeader.apply(this, arguments);
    };
    
    XMLHttpRequest.prototype.send = function(body) {
      if (this._headers['X-Sign']) {
        window._capturedXhrHeaders.push({
          url: this._url,
          method: this._method,
          headers: { ...this._headers },
          bodySnippet: typeof body === 'string' ? body.slice(0, 200) : null,
        });
      }
      return origSend.apply(this, arguments);
    };

    // 也 hook fetch
    const origFetch = window.fetch;
    window.fetch = function(...args) {
      const [url, opts] = args;
      const headers = opts?.headers || {};
      let headerObj = {};
      if (headers instanceof Headers) {
        headers.forEach((v, k) => { headerObj[k] = v; });
      } else if (typeof headers === 'object') {
        headerObj = { ...headers };
      }
      if (headerObj['X-Sign']) {
        window._capturedXhrHeaders.push({
          url: typeof url === 'string' ? url : url?.url,
          method: opts?.method || 'GET',
          headers: headerObj,
          bodySnippet: typeof opts?.body === 'string' ? opts.body.slice(0, 200) : null,
          type: 'fetch',
        });
      }
      return origFetch.apply(this, args);
    };
  });
  
  console.log('导航到 chatglm...');
  await page.goto('https://chatglm.cn/main/chatfree', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);
  
  // 获取捕获的头
  const captured = await page.evaluate(() => window._capturedXhrHeaders);
  console.log(`\n捕获到 ${captured.length} 个带签名的请求`);
  
  for (let i = 0; i < Math.min(captured.length, 5); i++) {
    const req = captured[i];
    console.log(`\n[${i + 1}] ${req.method} ${req.url}`);
    console.log(`  X-Sign: ${req.headers['X-Sign']}`);
    console.log(`  X-Nonce: ${req.headers['X-Nonce']}`);
    console.log(`  X-Timestamp: ${req.headers['X-Timestamp']}`);
    console.log(`  X-Device-Id: ${req.headers['X-Device-Id']}`);
    console.log(`  Authorization: ${req.headers['Authorization']?.slice(0, 50)}...`);
    console.log(`  Type: ${req.type || 'xhr'}`);
  }

  // 多次捕获签名来分析规律
  if (captured.length > 0) {
    console.log('\n=== 签名规律分析 ===');
    for (const req of captured.slice(0, 5)) {
      const ts = req.headers['X-Timestamp'];
      const nonce = req.headers['X-Nonce'];
      const sign = req.headers['X-Sign'];
      const deviceId = req.headers['X-Device-Id'];
      console.log(`ts=${ts} nonce=${nonce} sign=${sign}`);
    }
    
    // 尝试用 CryptoJS MD5 在页面中验证签名
    console.log('\n=== 尝试在页面中重现签名 ===');
    const verifyResult = await page.evaluate((samples) => {
      const results = [];
      
      // 尝试找到 CryptoJS
      let md5Fn = null;
      
      // 搜索 webpack 模块
      const chunkNames = Object.keys(window).filter(k => k.startsWith('webpackChunk'));
      results.push(`webpack chunk keys: ${chunkNames.join(', ')}`);
      
      for (const chunkName of chunkNames) {
        const chunks = window[chunkName];
        if (!Array.isArray(chunks)) continue;
        
        for (const chunk of chunks) {
          if (!chunk[1]) continue;
          for (const [id, fn] of Object.entries(chunk[1])) {
            const fnStr = fn.toString().slice(0, 500);
            if (fnStr.includes('MD5') && fnStr.includes('toString')) {
              results.push(`Found MD5 in module ${id}: ${fnStr.slice(0, 200)}`);
            }
          }
        }
      }
      
      return results;
    }, captured);
    
    for (const r of verifyResult) {
      console.log(r);
    }
  }

  await page.close();
  browser.close();
}

main().catch(e => console.error(e.message));
