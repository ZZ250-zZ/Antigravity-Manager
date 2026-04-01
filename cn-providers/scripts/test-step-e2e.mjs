#!/usr/bin/env node
/**
 * 端到端测试 Step Provider：提取 cookie → 注册 token → 发送 OpenAI 请求
 */
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const cookies = await ctx.cookies(['https://www.stepfun.com']);
const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
console.log('Extracted cookies:', cookies.map(c => c.name).join(', '));
browser.close();

// 注册 token
const regRes = await fetch('http://127.0.0.1:8046/v1/tokens', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ provider: 'step', token: cookieStr }),
});
console.log('Token registration:', regRes.status);

// 发送聊天请求
const chatRes = await fetch('http://127.0.0.1:8046/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'step',
    messages: [{ role: 'user', content: '用一句话介绍长城' }],
    stream: true,
  }),
});

console.log('Chat status:', chatRes.status);
const text = await chatRes.text();
console.log('Response:', text.slice(0, 1500));
