#!/usr/bin/env node
/**
 * 测试 Kimi 完整 API 流程：refresh → create chat → completion
 */
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find(p => p.url().includes('kimi.com'));
const refreshToken = await page.evaluate(() => localStorage.getItem('refresh_token'));
console.log('refresh_token:', refreshToken?.slice(0, 50) + '...');
browser.close();

const BASE = 'https://kimi.moonshot.cn';

// 1. Refresh token (GET)
const refreshRes = await fetch(`${BASE}/api/auth/token/refresh`, {
  method: 'GET',
  headers: { Authorization: `Bearer ${refreshToken}` },
});
const refreshData = await refreshRes.json();
const accessToken = refreshData.access_token;
console.log('Refresh status:', refreshRes.status);
console.log('access_token:', accessToken?.slice(0, 50) + '...');

// 2. Create chat
const createRes = await fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ name: '测试', is_example: false }),
});
const createData = await createRes.json();
console.log('\nCreate chat status:', createRes.status);
console.log('Chat ID:', createData.id);

if (!createData.id) {
  console.error('Failed to create chat:', JSON.stringify(createData).slice(0, 500));
  process.exit(1);
}

// 3. Chat completion (SSE)
const completionRes = await fetch(`${BASE}/api/chat/${createData.id}/completion/stream`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  },
  body: JSON.stringify({
    messages: [{ role: 'user', content: '用一句话介绍长城' }],
    refs: [],
    use_search: false,
    kimiplus_id: 'kimi',
  }),
});

console.log('\nCompletion status:', completionRes.status);
const text = await completionRes.text();

// 解析 SSE
const lines = text.split('\n');
let content = '';
for (const line of lines) {
  if (!line.startsWith('data:')) continue;
  const payload = line.slice(5).trimStart();
  if (payload === '[DONE]' || !payload) continue;
  try {
    const obj = JSON.parse(payload);
    if (obj.event === 'cmpl' && typeof obj.text === 'string') {
      content += obj.text;
    }
    // 打印前几行看格式
    if (lines.indexOf(line) < 20) {
      console.log('SSE:', JSON.stringify(obj).slice(0, 200));
    }
  } catch {}
}

console.log('\nFull content:', content);

// 4. 删除会话
const delRes = await fetch(`${BASE}/api/chat/${createData.id}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${accessToken}` },
});
console.log('\nDelete status:', delRes.status);
