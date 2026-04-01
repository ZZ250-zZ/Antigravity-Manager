#!/usr/bin/env node
/**
 * 端到端测试 Zhipu Provider（含签名）
 * 1. 从 CDP 提取 chatglm_token
 * 2. 注册到 sidecar
 * 3. 发送 OpenAI 格式请求
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const SIDECAR_URL = 'http://127.0.0.1:8046';

async function extractToken() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const cookies = await context.cookies('https://chatglm.cn');
  const tokenCookie = cookies.find(c => c.name === 'chatglm_token');
  browser.close();
  
  if (!tokenCookie) throw new Error('chatglm_token cookie not found');
  return tokenCookie.value;
}

async function registerToken(token) {
  const res = await fetch(`${SIDECAR_URL}/v1/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ zhipu: token }),
  });
  const data = await res.json();
  console.log('Token 注册:', data);
}

async function testChat() {
  const body = {
    model: 'zhipu',
    messages: [{ role: 'user', content: '请用一句话介绍你自己' }],
    stream: true,
  };

  console.log('\n发送测试请求...');
  const res = await fetch(`${SIDECAR_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  console.log(`状态: ${res.status}`);

  if (!res.ok) {
    const errText = await res.text();
    console.error('错误:', errText.slice(0, 500));
    return;
  }

  // 读取 SSE 流
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';
  let chunkCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value, { stream: true });
    const lines = text.split('\n');
    
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') {
        console.log('\n[DONE]');
        continue;
      }

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          fullContent += delta;
          process.stdout.write(delta);
          chunkCount++;
        }
      } catch {}
    }
  }

  console.log(`\n\n总共 ${chunkCount} 个 chunk`);
  console.log(`完整内容: ${fullContent}`);
}

async function main() {
  console.log('=== Zhipu 端到端测试 ===\n');
  
  // 提取 token
  console.log('提取 chatglm_token...');
  const token = await extractToken();
  console.log(`Token: ${token.slice(0, 30)}...`);

  // 注册
  await registerToken(token);

  // 测试
  await testChat();
}

main().catch(e => console.error('Error:', e.message));
