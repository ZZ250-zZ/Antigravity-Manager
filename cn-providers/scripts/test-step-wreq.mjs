#!/usr/bin/env node
import { chromium } from 'playwright';
import { httpRequest } from '../src/http-client.mjs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const cookies = await ctx.cookies(['https://www.stepfun.com']);
const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
browser.close();

const headers = {
  'Content-Type': 'application/json',
  'Cookie': cookieStr,
  'connect-protocol-version': '1',
  'oasis-appid': '10200',
  'oasis-language': 'zh',
  'oasis-platform': 'web',
  'x-waf-client-type': 'fetch_sdk',
  'canary': 'false',
  'Origin': 'https://www.stepfun.com',
  'Referer': 'https://www.stepfun.com/chats/new',
};

console.log('Testing CreateChatSession with wreq-js...');
const res = await httpRequest('https://www.stepfun.com/api/agent/capy.agent.v1.AgentService/CreateChatSession', {
  method: 'POST',
  headers,
  body: '{}',
});
const text = await res.text();
console.log('Status:', res.status);
console.log('Body:', text.slice(0, 500));
