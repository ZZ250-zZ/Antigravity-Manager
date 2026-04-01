#!/usr/bin/env node
/**
 * 在浏览器中用完整 headers 请求 Step API，捕获响应格式
 */
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];

let page = ctx.pages().find(p => {
  try { return new URL(p.url()).hostname.includes('stepfun'); } catch { return false; }
});
let newPage = false;
if (!page) {
  page = await ctx.newPage();
  newPage = true;
  await page.goto('https://www.stepfun.com/chats/new', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(3000);
}

console.log('Using page:', page.url());

const result = await page.evaluate(async () => {
  const BASE = 'https://www.stepfun.com';
  const apiHeaders = {
    'Content-Type': 'application/json',
    'connect-protocol-version': '1',
    'oasis-appid': '10200',
    'oasis-language': 'zh',
    'oasis-platform': 'web',
    'x-waf-client-type': 'fetch_sdk',
    'canary': 'false',
  };
  
  // 1. 创建会话
  const createRes = await fetch(`${BASE}/api/agent/capy.agent.v1.AgentService/CreateChatSession`, {
    method: 'POST',
    headers: apiHeaders,
    body: '{}',
    credentials: 'include',
  });
  const sessionText = await createRes.text();
  if (!createRes.ok) return { error: 'create_failed', status: createRes.status, body: sessionText.slice(0, 500) };
  
  let sessionData;
  try { sessionData = JSON.parse(sessionText); } catch { return { error: 'parse_error', raw: sessionText.slice(0, 500) }; }
  const chatSessionId = sessionData.chatSession?.chatSessionId || sessionData.chatSessionId;
  if (!chatSessionId) return { error: 'no_session_id', raw: sessionText.slice(0, 500) };
  
  // 2. ChatStream
  const payload = JSON.stringify({
    message: {
      chatSessionId,
      content: { userMessage: { qa: { content: '你好' } } },
    },
    config: { model: 'step-auto', enableReasoning: false, enableSearch: false },
  });
  
  const payloadBytes = new TextEncoder().encode(payload);
  const frame = new Uint8Array(5 + payloadBytes.length);
  frame[0] = 0x00;
  const len = payloadBytes.length;
  frame[1] = (len >> 24) & 0xff;
  frame[2] = (len >> 16) & 0xff;
  frame[3] = (len >> 8) & 0xff;
  frame[4] = len & 0xff;
  frame.set(payloadBytes, 5);
  
  const streamRes = await fetch(`${BASE}/api/agent/capy.agent.v1.AgentService/ChatStream`, {
    method: 'POST',
    headers: { ...apiHeaders, 'Content-Type': 'application/connect+json' },
    body: frame,
    credentials: 'include',
  });
  
  const contentType = streamRes.headers.get('content-type');
  
  // 读取响应帧
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = new Uint8Array(0);
  
  while (frames.length < 15) {
    const { done, value } = await reader.read();
    if (done) break;
    const newBuf = new Uint8Array(buffer.length + value.length);
    newBuf.set(buffer);
    newBuf.set(value, buffer.length);
    buffer = newBuf;
    
    while (buffer.length >= 5) {
      const flags = buffer[0];
      const fLen = (buffer[1] << 24) | (buffer[2] << 16) | (buffer[3] << 8) | buffer[4];
      if (buffer.length < 5 + fLen) break;
      const frameData = decoder.decode(buffer.slice(5, 5 + fLen));
      frames.push({ flags, len: fLen, data: frameData.slice(0, 600) });
      buffer = buffer.slice(5 + fLen);
    }
  }
  reader.cancel();
  
  // 3. 删除会话
  await fetch(`${BASE}/api/agent/capy.agent.v1.AgentService/DeleteChatSession`, {
    method: 'POST',
    headers: apiHeaders,
    body: JSON.stringify({ chatSessionId }),
    credentials: 'include',
  });
  
  return { chatSessionId, status: streamRes.status, contentType, frameCount: frames.length, frames };
});

console.log(JSON.stringify(result, null, 2));

if (newPage) await page.close();
browser.close();
