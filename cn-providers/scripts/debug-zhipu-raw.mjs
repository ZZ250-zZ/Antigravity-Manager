#!/usr/bin/env node
/**
 * 抓取 Zhipu 原始 SSE 数据格式
 */
import { createHash, randomUUID } from 'node:crypto';
import { httpRequest } from '../src/http-client.mjs';
import { writeFile } from 'node:fs/promises';

const ZHIPU_BASE = 'https://chatglm.cn';
const SIGN_SALT = '8a1317a7468aa3ad86e997d08f3f31cb';

function makeTimestamp() {
  const raw = Date.now().toString();
  const len = raw.length;
  const digits = raw.split('').map(Number);
  const checksum = digits.reduce((a, b) => a + b, 0) - digits[len - 2];
  return raw.substring(0, len - 2) + (checksum % 10) + raw.substring(len - 1, len);
}

function hexUUID() { return randomUUID().replace(/-/g, ''); }

function generateSign() {
  const timestamp = makeTimestamp();
  const xNonce = hexUUID();
  const sign = createHash('md5').update(`${timestamp}-${xNonce}-${SIGN_SALT}`).digest('hex');
  return { timestamp, xNonce, sign };
}

// 从持久化文件加载 token
import { getValidTokens } from '../src/utils/token-store.mjs';

async function main() {
  const tokens = await getValidTokens();
  const token = tokens.zhipu;
  if (!token) { console.error('No zhipu token'); return; }
  
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
    Accept: 'text/event-stream',
    Origin: ZHIPU_BASE,
    Referer: `${ZHIPU_BASE}/main/chatfree`,
  };
  
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
  
  const res = await httpRequest(`${ZHIPU_BASE}/chatglm/backend-api/assistant/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  
  console.log('Status:', res.status);
  if (!res.ok) {
    console.log('Error:', await res.text());
    return;
  }
  
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let rawOutput = '';
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    rawOutput += text;
    
    // 解析每一行，打印具体的 JSON 结构
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      
      try {
        const parsed = JSON.parse(data);
        console.log('\n--- SSE event ---');
        console.log('Keys:', Object.keys(parsed));
        
        if (parsed.parts) {
          console.log('parts[0] keys:', Object.keys(parsed.parts[0]));
          console.log('parts[0].content type:', typeof parsed.parts[0].content);
          
          if (typeof parsed.parts[0].content === 'string') {
            console.log('parts[0].content:', parsed.parts[0].content.slice(0, 200));
          } else {
            console.log('parts[0].content:', JSON.stringify(parsed.parts[0].content).slice(0, 500));
          }
          
          if (parsed.parts[0].status) {
            console.log('parts[0].status:', parsed.parts[0].status);
          }
        }
        
        if (parsed.conversation_id) {
          console.log('conversation_id:', parsed.conversation_id);
        }
      } catch (e) {
        console.log('Parse error for:', data.slice(0, 100));
      }
    }
  }
  
  // 保存原始数据
  await writeFile('debug/zhipu-raw-sse.txt', rawOutput, 'utf-8');
  console.log('\n\n原始 SSE 数据已保存到 debug/zhipu-raw-sse.txt');
}

main().catch(e => console.error(e.message));
