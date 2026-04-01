#!/usr/bin/env node
/**
 * 通过 CDP 下载并搜索 Zhipu 签名算法
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  
  // 找一个 chatglm 页面
  let page = context.pages().find(p => p.url().includes('chatglm'));
  if (!page) {
    page = await context.newPage();
    await page.goto('https://chatglm.cn/main/chatfree', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
  }

  // 直接在页面上下文中执行搜索 - 找到签名函数
  console.log('=== 方法1：从页面提取签名函数源码 ===');
  
  // 尝试在页面中找到签名函数并执行
  const signTest = await page.evaluate(() => {
    // 搜索全局模块
    const results = {};
    
    // 尝试调用 window 上的签名相关函数
    // chatglm 的 webpack 模块可能在 webpackChunk 中
    if (typeof window.__NEXT_DATA__ !== 'undefined') {
      results.nextData = true;
    }
    
    // 尝试找到 axios/fetch 拦截器
    if (typeof window.axios !== 'undefined') {
      results.hasAxios = true;
    }

    // 检查所有 script 标签的 src
    const scripts = Array.from(document.querySelectorAll('script[src]'));
    results.scripts = scripts.map(s => s.src).filter(s => s.includes('main') || s.includes('vendor') || s.includes('chunk'));

    return results;
  });
  console.log('Scripts:', JSON.stringify(signTest.scripts, null, 2));

  // 方法2：直接在页面中找签名函数并输出结果
  console.log('\n=== 方法2：调用签名函数 ===');
  const signResult = await page.evaluate(() => {
    // 搜索 webpack 模块中的签名函数
    // chatglm 使用 CryptoJS MD5
    
    // 尝试 CryptoJS
    if (typeof window.CryptoJS !== 'undefined') {
      return { hasCryptoJS: true };
    }

    // 尝试通过拦截 XMLHttpRequest 来获取签名
    const results = {};
    
    // 检查是否有全局的签名生成工具
    for (const key of Object.getOwnPropertyNames(window)) {
      try {
        const val = window[key];
        if (typeof val === 'function' && /sign|nonce|device/i.test(key)) {
          results[key] = 'function';
        }
      } catch {}
    }

    return results;
  });
  console.log('Sign search:', JSON.stringify(signResult));

  // 方法3：hook fetch 来抓签名头
  console.log('\n=== 方法3：Hook fetch 捕获签名头 ===');
  await page.evaluate(() => {
    const origFetch = window.fetch;
    window._capturedHeaders = [];
    window.fetch = function(...args) {
      if (args[1]?.headers) {
        const h = {};
        if (args[1].headers instanceof Headers) {
          args[1].headers.forEach((v, k) => { h[k] = v; });
        } else {
          Object.assign(h, args[1].headers);
        }
        if (h['X-Sign']) {
          window._capturedHeaders.push({
            url: typeof args[0] === 'string' ? args[0] : args[0]?.url,
            sign: h['X-Sign'],
            nonce: h['X-Nonce'],
            timestamp: h['X-Timestamp'],
            requestId: h['X-Request-Id'],
          });
        }
      }
      return origFetch.apply(this, args);
    };
  });

  // 触发一个 API 调用来捕获签名
  await page.evaluate(async () => {
    try {
      await fetch('/chatglm/user-api/user/info');
    } catch {}
  });
  await page.waitForTimeout(2000);

  const capturedHeaders = await page.evaluate(() => window._capturedHeaders);
  console.log('Captured headers:', JSON.stringify(capturedHeaders, null, 2));

  // 方法4：直接让页面生成签名并返回
  console.log('\n=== 方法4：尝试让页面生成签名 ===');
  
  // 搜索 webpack 模块
  const moduleSearch = await page.evaluate(() => {
    // 尝试访问 webpack 模块
    const chunks = window.webpackChunkpc_chatglm || window.webpackChunk_N_E || [];
    const results = { chunkCount: chunks.length };
    
    // 遍历 webpack 模块寻找签名函数
    for (const chunk of chunks) {
      if (!chunk[1]) continue;
      const modules = chunk[1];
      for (const [moduleId, moduleFn] of Object.entries(modules)) {
        const fnStr = moduleFn.toString();
        if (fnStr.includes('X-Sign') || fnStr.includes('xNonce')) {
          results.foundModule = moduleId;
          // 提取签名相关代码
          const signIdx = fnStr.indexOf('xNonce');
          if (signIdx >= 0) {
            results.signContext = fnStr.slice(Math.max(0, signIdx - 500), signIdx + 500);
          }
          break;
        }
      }
      if (results.foundModule) break;
    }
    
    return results;
  });
  console.log('Module search:', moduleSearch.chunkCount, 'chunks');
  if (moduleSearch.foundModule) {
    console.log('Found in module:', moduleSearch.foundModule);
    console.log('Sign context:', moduleSearch.signContext);
  }

  browser.close();
}

main().catch(e => console.error(e.message));
