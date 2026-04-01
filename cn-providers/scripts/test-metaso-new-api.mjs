#!/usr/bin/env node
/**
 * 直接测试 Metaso 新 API /api/search/chat
 */
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];

  // 获取所有 metaso cookies
  const cookies = await context.cookies();
  const metasoCookies = cookies.filter(c => c.domain.includes('metaso.cn') && !c.domain.includes('cdn'));
  const cookieStr = metasoCookies.map(c => `${c.name}=${c.value}`).join('; ');
  console.log('Cookie 数量:', metasoCookies.length);
  console.log('Cookie names:', metasoCookies.map(c => c.name).join(', '));
  browser.close();

  // 构造请求
  const conversationId = `temp-${randomUUID()}`;
  const body = {
    model: 'fast_thinking',
    stream: true,
    messages: [{
      id: `temp-${randomUUID()}`,
      key: `temp-${randomUUID()}`,
      conversationId,
      role: 'user',
      content: '你好',
      markdownContent: '你好',
      engineType: '',
      filter: 'all',
      contentType: 0,
      outputHtml: false,
      mode: 'detail',
      model: 'fast_thinking',
      outputStyle: '正常',
    }],
    engineType: '',
    mode: 'detail',
    filter: 'all',
    outputHtml: false,
    outputStyle: '正常',
    darkMode: false,
  };

  console.log('\n=== 请求 /api/search/chat ===');
  console.log('Body:', JSON.stringify(body, null, 2).slice(0, 500));

  const res = await fetch('https://metaso.cn/api/search/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Cookie: cookieStr,
      Origin: 'https://metaso.cn',
      Referer: `https://metaso.cn/search-v2/${conversationId}`,
    },
    body: JSON.stringify(body),
  });

  console.log('\nStatus:', res.status);
  console.log('Content-Type:', res.headers.get('content-type'));

  if (!res.ok) {
    const errText = await res.text();
    console.log('Error:', errText.slice(0, 500));
    return;
  }

  // 读取 SSE 流
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let chunkCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 打印原始行
      if (trimmed.startsWith('data:')) {
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') {
          console.log('\n[DONE]');
          continue;
        }
        chunkCount++;
        try {
          const obj = JSON.parse(payload);
          const keys = Object.keys(obj);
          console.log(`\n[${chunkCount}] keys: ${keys.join(',')}`);
          // 打印关键字段
          if (obj.type !== undefined) console.log(`  type: ${obj.type}`);
          if (obj.data !== undefined) console.log(`  data: ${JSON.stringify(obj.data).slice(0, 200)}`);
          if (obj.content !== undefined) console.log(`  content: ${JSON.stringify(obj.content).slice(0, 200)}`);
          if (obj.text !== undefined) console.log(`  text: ${JSON.stringify(obj.text).slice(0, 200)}`);
          if (obj.message !== undefined) console.log(`  message: ${JSON.stringify(obj.message).slice(0, 200)}`);
          if (obj.delta !== undefined) console.log(`  delta: ${JSON.stringify(obj.delta).slice(0, 200)}`);
          if (obj.id !== undefined) console.log(`  id: ${obj.id}`);
          if (obj.conversationId !== undefined) console.log(`  conversationId: ${obj.conversationId}`);
          if (obj.event !== undefined) console.log(`  event: ${obj.event}`);
          if (obj.msg !== undefined) console.log(`  msg: ${obj.msg}`);
          if (obj.code !== undefined) console.log(`  code: ${obj.code}`);
          if (obj.showToast !== undefined) console.log(`  showToast: ${obj.showToast}`);
          // 打印完整 JSON（小的 chunk）
          const full = JSON.stringify(obj);
          if (full.length < 500) console.log(`  FULL: ${full}`);
        } catch {
          console.log(`[${chunkCount}] RAW: ${payload.slice(0, 200)}`);
        }
      } else if (trimmed.startsWith('event:')) {
        console.log(`\n  EVENT: ${trimmed.slice(6).trim()}`);
      } else {
        // 其他格式
        if (chunkCount < 3) console.log(`  OTHER: ${trimmed.slice(0, 100)}`);
      }

      if (chunkCount > 30) {
        console.log('\n... (truncated)');
        reader.releaseLock();
        return;
      }
    }
  }

  console.log(`\n总计 ${chunkCount} chunks`);
}

main().catch(e => console.error(e.message));
