#!/usr/bin/env node
/**
 * 直接用 wreq-js 测试 Zhipu 签名请求（跳过 sidecar）
 */
import { chromium } from 'playwright';
import { createHash, randomUUID } from 'node:crypto';
import { httpRequest } from '../src/http-client.mjs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const ZHIPU_BASE = 'https://chatglm.cn';
const SIGN_SALT = '8a1317a7468aa3ad86e997d08f3f31cb';

function makeTimestamp() {
  const raw = Date.now().toString();
  const len = raw.length;
  const digits = raw.split('').map(Number);
  const checksum = digits.reduce((a, b) => a + b, 0) - digits[len - 2];
  return raw.substring(0, len - 2) + (checksum % 10) + raw.substring(len - 1, len);
}

function hexUUID() {
  return randomUUID().replace(/-/g, '');
}

function generateSign() {
  const timestamp = makeTimestamp();
  const xNonce = hexUUID();
  const sign = createHash('md5').update(`${timestamp}-${xNonce}-${SIGN_SALT}`).digest('hex');
  return { timestamp, xNonce, sign };
}

async function main() {
  // 1. 提取 token
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const cookies = await context.cookies('https://chatglm.cn');
  const tokenCookie = cookies.find(c => c.name === 'chatglm_token');
  
  if (!tokenCookie) {
    console.error('chatglm_token cookie not found!');
    const allNames = cookies.map(c => c.name).join(', ');
    console.log('Available cookies:', allNames);
    browser.close();
    return;
  }
  
  const token = tokenCookie.value;
  console.log(`Token: ${token.slice(0, 40)}...`);
  console.log(`Token expiry: ${new Date(tokenCookie.expires * 1000).toISOString()}`);
  
  browser.close();
  
  // 2. 测试 user/info 端点
  const deviceId = hexUUID();
  const { timestamp, xNonce, sign } = generateSign();
  
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'App-Name': 'chatglm',
    'X-Device-Id': deviceId,
    'X-App-Platform': 'pc',
    'X-App-Version': '0.0.1',
    'X-Request-Id': hexUUID(),
    'X-Timestamp': timestamp,
    'X-Nonce': xNonce,
    'X-Sign': sign,
    Origin: ZHIPU_BASE,
    Referer: `${ZHIPU_BASE}/main/chatfree`,
  };
  
  console.log('\n=== 测试 1: user/info (GET) ===');
  console.log('Headers:', JSON.stringify(headers, null, 2));
  
  try {
    const res = await httpRequest(`${ZHIPU_BASE}/chatglm/user-api/user/info`, {
      method: 'GET',
      headers,
    });
    const body = await res.text();
    console.log(`Status: ${res.status}`);
    console.log(`Response: ${body.slice(0, 500)}`);
  } catch (e) {
    console.error('Error:', e.message);
  }
  
  // 3. 测试 stream 端点
  console.log('\n=== 测试 2: assistant/stream (POST) ===');
  const { timestamp: ts2, xNonce: n2, sign: s2 } = generateSign();
  const streamHeaders = {
    ...headers,
    'X-Timestamp': ts2,
    'X-Nonce': n2,
    'X-Sign': s2,
    'X-Request-Id': hexUUID(),
    Accept: 'text/event-stream',
  };
  
  const streamBody = {
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
  
  try {
    const res = await httpRequest(`${ZHIPU_BASE}/chatglm/backend-api/assistant/stream`, {
      method: 'POST',
      headers: streamHeaders,
      body: JSON.stringify(streamBody),
    });
    
    console.log(`Status: ${res.status}`);
    
    if (!res.ok) {
      const errBody = await res.text();
      console.log(`Error body: ${errBody.slice(0, 500)}`);
      
      // 输出完整的响应头
      console.log('\nResponse headers:');
      res.headers.forEach((v, k) => console.log(`  ${k}: ${v}`));
      return;
    }
    
    // 读取 SSE 流
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let chunks = 0;
    let conversationId = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const text = decoder.decode(value, { stream: true });
      const lines = text.split('\n');
      
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '') continue;
        
        try {
          const parsed = JSON.parse(data);
          if (parsed.conversation_id) conversationId = parsed.conversation_id;
          
          const content = parsed.parts?.[0]?.content;
          if (content && chunks < 3) {
            console.log(`Chunk ${chunks}: ${content.slice(0, 100)}`);
          }
          chunks++;
        } catch {}
      }
    }
    
    console.log(`\n总共 ${chunks} 个 chunk`);
    console.log(`Conversation ID: ${conversationId}`);
    
  } catch (e) {
    console.error('Error:', e.message);
  }
}

main().catch(e => console.error(e.message));
