#!/usr/bin/env node
/**
 * 完整捕获 Step ChatStream 的所有帧（包括最终回复文本）
 */
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
let page = ctx.pages().find(p => {
  try { return new URL(p.url()).hostname.includes('stepfun'); } catch { return false; }
});
if (!page) {
  page = await ctx.newPage();
  await page.goto('https://www.stepfun.com/chats/new', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(3000);
}

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
  
  const createRes = await fetch(`${BASE}/api/agent/capy.agent.v1.AgentService/CreateChatSession`, {
    method: 'POST', headers: apiHeaders, body: '{}', credentials: 'include',
  });
  const sessionData = await createRes.json();
  const chatSessionId = sessionData.chatSession?.chatSessionId;
  
  // 禁用 reasoning，只要纯文本回复
  const payload = JSON.stringify({
    message: {
      chatSessionId,
      content: { userMessage: { qa: { content: '用一句话介绍长城' } } },
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
  
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = new Uint8Array(0);
  
  while (frames.length < 500) {
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
      frames.push({ flags, data: frameData.slice(0, 300) });
      buffer = buffer.slice(5 + fLen);
    }
  }
  reader.cancel();
  
  // 删除会话
  await fetch(`${BASE}/api/agent/capy.agent.v1.AgentService/DeleteChatSession`, {
    method: 'POST', headers: apiHeaders, body: JSON.stringify({ chatSessionId }), credentials: 'include',
  });
  
  return { chatSessionId, frameCount: frames.length, frames };
});

for (const [i, f] of result.frames.entries()) {
  try {
    const obj = JSON.parse(f.data);
    const event = obj.data?.event;
    const eventType = event ? Object.keys(event)[0] : 'unknown';
    let text = '';
    if (event?.textEvent?.text) text = event.textEvent.text;
    if (event?.reasoningEvent?.text) text = event.reasoningEvent.text;
    console.log(`Frame ${i}: ${eventType}${text ? ' → ' + JSON.stringify(text) : ''}`);
    if (eventType === 'messageEvent' || eventType === 'startEvent' || eventType === 'pipelineEvent') {
      console.log('  Detail:', f.data.slice(0, 200));
    }
  } catch {
    console.log(`Frame ${i}: RAW`, f.data.slice(0, 200));
  }
}
console.log(`\nTotal: ${result.frameCount} frames`);

await page.close();
browser.close();
