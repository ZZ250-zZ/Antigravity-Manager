#!/usr/bin/env node
/**
 * 对比 Zhipu 请求：浏览器 vs wreq-js
 * 1. 在浏览器中发送请求并捕获完整的请求头
 * 2. 用 wreq-js 发同样的请求，捕获失败详情
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const ZHIPU_STREAM = 'https://chatglm.cn/chatglm/backend-api/assistant/stream';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  
  // 获取 token
  const cookies = await context.cookies();
  const tokenCookie = cookies.find(c => c.name === 'chatglm_token');
  if (!tokenCookie) {
    console.log('未找到 chatglm_token Cookie');
    browser.close();
    return;
  }
  const token = tokenCookie.value;
  console.log('Token:', token.slice(0, 30) + '...');

  // 获取所有 zhipu cookies
  const zhipuCookies = cookies.filter(c => c.domain.includes('chatglm'));
  console.log('\n=== Zhipu Cookies ===');
  for (const c of zhipuCookies) {
    console.log(`  ${c.name} = ${c.value.slice(0, 40)}... (domain: ${c.domain})`);
  }

  const body = {
    assistant_id: '65940acff94777010aa6b796',
    conversation_id: '',
    project_id: '',
    chat_type: 'user_chat',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    meta_data: {
      cogview: { rm_label_watermark: false },
      is_networking: false,
      input_question_type: 'xxxx',
      is_test: false,
      platform: 'pc',
    },
  };

  // 方法1：在浏览器页面中执行 fetch
  console.log('\n=== 方法1：浏览器 page.evaluate fetch ===');
  let page = context.pages().find(p => p.url().includes('chatglm'));
  if (!page) {
    page = await context.newPage();
    await page.goto('https://chatglm.cn/main/chatfree', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
  }

  const browserResult = await page.evaluate(async (args) => {
    const { url, body, token } = args;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
      });
      
      // 只读前几个 chunk
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const chunks = [];
      let count = 0;
      while (count < 5) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const p = t.slice(5).trim();
          if (p === '[DONE]') { chunks.push('[DONE]'); continue; }
          if (!p) continue;
          count++;
          chunks.push(p.slice(0, 300));
        }
      }
      reader.releaseLock();
      return { status: res.status, contentType: res.headers.get('content-type'), chunks };
    } catch (e) {
      return { error: e.message };
    }
  }, { url: ZHIPU_STREAM, body, token });

  console.log('Status:', browserResult.status);
  console.log('Content-Type:', browserResult.contentType);
  if (browserResult.error) console.log('Error:', browserResult.error);
  if (browserResult.chunks) {
    for (const c of browserResult.chunks) {
      console.log('  Chunk:', c.slice(0, 200));
    }
  }

  // 方法2：用 wreq-js 发请求
  console.log('\n=== 方法2：wreq-js httpRequest ===');
  const { httpRequest } = await import('../src/http-client.mjs');
  try {
    const res2 = await httpRequest(ZHIPU_STREAM, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
        Origin: 'https://chatglm.cn',
        Referer: 'https://chatglm.cn/main/chatfree',
      },
      body: JSON.stringify(body),
    });
    console.log('Status:', res2.status);
    const text = await res2.text();
    console.log('Response:', text.slice(0, 500));
  } catch (e) {
    console.log('Error:', e.message);
  }

  // 方法3：用 wreq-js 带完整 cookie
  console.log('\n=== 方法3：wreq-js + 完整 Cookie ===');
  const fullCookie = zhipuCookies.map(c => `${c.name}=${c.value}`).join('; ');
  try {
    const res3 = await httpRequest(ZHIPU_STREAM, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
        Origin: 'https://chatglm.cn',
        Referer: 'https://chatglm.cn/main/chatfree',
        Cookie: fullCookie,
      },
      body: JSON.stringify(body),
    });
    console.log('Status:', res3.status);
    const text = await res3.text();
    console.log('Response:', text.slice(0, 500));
  } catch (e) {
    console.log('Error:', e.message);
  }

  browser.close();
}

main().catch(e => console.error(e.message));
