#!/usr/bin/env node
/**
 * 直接用 wreq-js 测试 Spark API（用已保存的 token）
 */
import { httpRequest } from '../src/http-client.mjs';
import { getValidTokens } from '../src/utils/token-store.mjs';

const BASE_URL = 'https://xinghuo.xfyun.cn';

async function main() {
  const tokens = await getValidTokens();
  const token = tokens.spark;
  if (!token) { console.error('No spark token saved'); return; }
  console.log('Token:', token.slice(0, 40) + '...');

  const headers = {
    'Content-Type': 'application/json',
    Cookie: `ssoSessionId=${token}`,
    Origin: BASE_URL,
    Referer: `${BASE_URL}/desk`,
  };

  // 1. 测试 chat-list v2
  console.log('\n=== 1. 测试 chat-list v2 ===');
  try {
    const res = await httpRequest(`${BASE_URL}/iflygpt/u/chat-list/v2/chat-list`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ pageNum: 1, pageSize: 5 }),
    });
    const text = await res.text();
    console.log(`Status: ${res.status}`);
    console.log(`Body: ${text.slice(0, 500)}`);
  } catch (e) {
    console.error('Error:', e.message);
  }

  // 2. 测试旧 create API
  console.log('\n=== 2. 测试旧 create API ===');
  try {
    const res = await httpRequest(`${BASE_URL}/iflygpt-chat/u/chat_list/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    const text = await res.text();
    console.log(`Status: ${res.status}`);
    console.log(`Body: ${text.slice(0, 500)}`);
  } catch (e) {
    console.error('Error:', e.message);
  }

  // 3. 测试新 create API（猜测的端点）
  console.log('\n=== 3. 测试新 create API ===');
  for (const endpoint of [
    '/iflygpt/u/chat-list/create',
    '/iflygpt/u/chat-list/v2/create',
    '/iflygpt/u/chat_list/create',
  ]) {
    try {
      const res = await httpRequest(`${BASE_URL}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      const text = await res.text();
      console.log(`  ${endpoint}: ${res.status} -> ${text.slice(0, 200)}`);
    } catch (e) {
      console.error(`  ${endpoint}: Error:`, e.message);
    }
  }

  // 4. 测试 GeeTest captcha
  console.log('\n=== 4. 测试 GeeTest captcha ===');
  try {
    const res = await httpRequest(`${BASE_URL}/iflygpt/chat/gee-captcha`, {
      method: 'GET',
      headers,
    });
    const text = await res.text();
    console.log(`Status: ${res.status}`);
    console.log(`Body: ${text.slice(0, 500)}`);
  } catch (e) {
    console.error('Error:', e.message);
  }

  // 5. 测试旧 send_text API
  console.log('\n=== 5. 测试旧 send_text API ===');
  try {
    const res = await httpRequest(`${BASE_URL}/iflygpt-chat/u/chat/send_text`, {
      method: 'POST',
      headers: { ...headers, Accept: 'text/event-stream' },
      body: JSON.stringify({ chatListId: '', content: '你好', GtToken: '', clientType: 1 }),
    });
    const text = await res.text();
    console.log(`Status: ${res.status}`);
    console.log(`Body: ${text.slice(0, 500)}`);
  } catch (e) {
    console.error('Error:', e.message);
  }

  // 6. 测试新 send-text API（猜测）
  console.log('\n=== 6. 测试新 send-text API ===');
  for (const endpoint of [
    '/iflygpt/u/chat/send-text',
    '/iflygpt/u/chat/send',
    '/iflygpt/chat/send-text',
  ]) {
    try {
      const res = await httpRequest(`${BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: { ...headers, Accept: 'text/event-stream' },
        body: JSON.stringify({ chatListId: '', content: '你好', GtToken: '', clientType: 1 }),
      });
      const text = await res.text();
      console.log(`  ${endpoint}: ${res.status} -> ${text.slice(0, 200)}`);
    } catch (e) {
      console.error(`  ${endpoint}: Error:`, e.message);
    }
  }
}

main().catch(e => console.error(e.message));
