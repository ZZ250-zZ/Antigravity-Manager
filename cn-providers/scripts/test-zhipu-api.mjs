#!/usr/bin/env node
import { chromium } from 'playwright';
import { httpRequest } from '../src/http-client.mjs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const cookies = await ctx.cookies(['https://chatglm.cn']);
browser.close();

const rt = cookies.find(c => c.name === 'chatglm_refresh_token')?.value;
const at = cookies.find(c => c.name === 'chatglm_token')?.value;
console.log('chatglm_token:', at?.slice(0, 50) + '...');
console.log('chatglm_refresh_token:', rt?.slice(0, 50) + '...');

// 尝试直接用 access_token 调用 API
const { generateZhipuSign, uuid } = await import('../src/utils/sign.mjs');

function headers(token, extra = {}) {
  const { sign, nonce, ts } = generateZhipuSign();
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Sign': sign,
    'X-Nonce': nonce,
    'X-Timestamp': ts,
    'App-Name': 'chatglm',
    'X-App-Platform': 'pc',
    'X-App-Version': '0.0.1',
    'X-App-Fr': 'default',
    'X-Lang': 'zh',
    'X-Device-Id': uuid(),
    'X-Request-Id': uuid(),
    ...extra,
  };
}

// 1. 用 refresh_token 刷新
console.log('\n1. Testing refresh with httpRequest (wreq-js)...');
const refreshRes = await httpRequest('https://chatglm.cn/chatglm/user-api/user/refresh', {
  method: 'POST',
  headers: headers(rt),
  body: '{}',
});
const refreshData = await refreshRes.json();
console.log('Refresh status:', refreshRes.status);
console.log('Refresh response:', JSON.stringify(refreshData).slice(0, 500));

// 如果刷新成功，用新 token；否则用现有 chatglm_token
const accessToken = refreshData.result?.accessToken || refreshData.result?.access_token || at;
console.log('Using token:', accessToken?.slice(0, 50) + '...');

// 2. 调用聊天 API
console.log('\n2. Testing chat stream...');
const body = {
  assistant_id: '65940acff94777010aa6b796',
  conversation_id: '',
  project_id: '',
  chat_type: 'user_chat',
  messages: [{ role: 'user', content: [{ type: 'text', text: '用一句话介绍长城' }] }],
  meta_data: {
    is_networking: false,
    input_question_type: 'xxxx',
    is_test: false,
    platform: 'pc',
  },
};

const chatRes = await httpRequest('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
  method: 'POST',
  headers: headers(accessToken, { Accept: 'text/event-stream' }),
  body: JSON.stringify(body),
});
console.log('Chat status:', chatRes.status);
const text = await chatRes.text();
// 解析 SSE 看内容
const lines = text.split('\n');
for (const line of lines.slice(0, 20)) {
  if (line.startsWith('data:')) {
    const payload = line.slice(5).trimStart();
    if (payload && payload !== '[DONE]') {
      try {
        const obj = JSON.parse(payload);
        console.log('SSE keys:', Object.keys(obj).join(','), '| parts:', JSON.stringify(obj.parts)?.slice(0, 200));
      } catch {}
    }
  }
}
