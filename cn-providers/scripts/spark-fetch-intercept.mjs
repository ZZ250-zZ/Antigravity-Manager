#!/usr/bin/env node
/**
 * 通过 CDP Fetch 域拦截 Spark 所有请求，
 * 用户在浏览器中手动发送消息，自动捕获 API
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  console.log('=== Spark Fetch 拦截器 ===\n');
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];

  // 找到已有的 Spark 页面
  let page = context.pages().find(p => p.url().includes('xinghuo.xfyun.cn'));
  if (!page) {
    console.log('没有找到 Spark 页面，请先在浏览器中打开 https://xinghuo.xfyun.cn/chat');
    console.log('然后重新运行此脚本');
    browser.close();
    return;
  }

  console.log('找到 Spark 页面:', page.url());

  // 使用 CDP Fetch 域拦截请求
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Network.enable');
  
  // 使用 Fetch 域拦截（可以拿到 request body）
  await cdpSession.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*iflygpt*', requestStage: 'Request' },
      { urlPattern: '*chat*', requestStage: 'Request' },
    ],
  });

  const captured = [];
  
  cdpSession.on('Fetch.requestPaused', async (params) => {
    const url = params.request.url;
    const method = params.request.method;
    
    // 过滤静态资源
    if (url.endsWith('.js') || url.endsWith('.css') || url.endsWith('.png') ||
        url.endsWith('.svg') || url.endsWith('.ico') || url.endsWith('.jpg') ||
        url.includes('/track') || url.includes('/log') || url.includes('daas-')) {
      await cdpSession.send('Fetch.continueRequest', { requestId: params.requestId });
      return;
    }

    const entry = {
      url,
      method,
      headers: params.request.headers,
      body: params.request.postData,
      hasPostData: params.request.hasPostData,
    };
    
    captured.push(entry);
    console.log(`📡 [${method}] ${url.split('?')[0]}`);
    
    if (params.request.postData) {
      console.log(`   Body: ${params.request.postData.slice(0, 500)}`);
    } else if (params.request.hasPostData) {
      // 获取 POST 数据
      try {
        const bodyResult = await cdpSession.send('Fetch.getResponseBody', { requestId: params.requestId }).catch(() => null);
        if (bodyResult) {
          console.log(`   Body (base64): ${bodyResult.body?.slice(0, 200)}`);
        }
      } catch { /* ok */ }
    }

    // 继续请求
    await cdpSession.send('Fetch.continueRequest', { requestId: params.requestId });
  });

  // 也监听响应
  cdpSession.on('Network.responseReceived', (params) => {
    const url = params.response.url;
    if (url.includes('iflygpt') && !url.endsWith('.js') && !url.endsWith('.css') &&
        !url.includes('.png') && !url.includes('.svg')) {
      const ct = params.response.headers['content-type'] || '';
      console.log(`   ← ${params.response.status} ${url.split('?')[0]} [${ct.slice(0, 40)}]`);
    }
  });

  console.log('\n⏳ 请在浏览器的 Spark 聊天页面中发送一条消息...');
  console.log('   脚本会自动捕获 API 请求。');
  console.log('   等待 60 秒...\n');

  await new Promise(r => setTimeout(r, 60000));

  // 停止拦截
  await cdpSession.send('Fetch.disable');

  console.log(`\n\n=== 捕获了 ${captured.length} 个请求 ===`);
  
  // 重点关注 POST 请求（尤其是带 body 的）
  const postReqs = captured.filter(r => r.method === 'POST' && (r.body || r.hasPostData));
  console.log(`\n其中 POST 请求: ${postReqs.length} 个`);
  for (const req of postReqs) {
    console.log(`\n--- POST ${req.url} ---`);
    const importantHeaders = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      if (['content-type', 'cookie', 'accept', 'origin', 'referer', 'x-requested-with', 'lang-code', 'clienttype', 'authorization'].includes(k.toLowerCase())) {
        importantHeaders[k] = v.length > 100 ? v.slice(0, 100) + '...' : v;
      }
    }
    console.log('Headers:', JSON.stringify(importantHeaders, null, 2));
    if (req.body) console.log('Body:', req.body.slice(0, 1000));
  }

  browser.close();
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
