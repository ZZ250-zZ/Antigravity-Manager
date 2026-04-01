#!/usr/bin/env node
/**
 * 调试各 Provider 的认证问题
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const cookies = await context.cookies();

  // === Step: 检查完整 Cookie ===
  console.log('=== Step Cookie 检查 ===');
  const stepCookies = cookies.filter(c => c.domain.includes('stepfun.com'));
  for (const c of stepCookies) {
    console.log(`  ${c.name} = ${c.value.slice(0, 30)}... (domain: ${c.domain})`);
  }
  const hasOasisToken = stepCookies.some(c => c.name === 'Oasis-Token');
  console.log(`  Oasis-Token: ${hasOasisToken ? '✅ 存在' : '❌ 不存在'}`);
  const fullStepCookie = stepCookies.map(c => `${c.name}=${c.value}`).join('; ');
  console.log(`  完整 Cookie 长度: ${fullStepCookie.length}`);

  // 在浏览器中测试 Step API
  let stepPage = context.pages().find(p => p.url().includes('stepfun.com'));
  if (!stepPage) {
    stepPage = await context.newPage();
    await stepPage.goto('https://www.stepfun.com/chats/new', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await stepPage.waitForTimeout(2000);
  }
  console.log('\n  Step 页面 URL:', stepPage.url());

  const stepResult = await stepPage.evaluate(async () => {
    try {
      const r = await fetch('https://www.stepfun.com/api/agent/capy.agent.v1.AgentService/CreateChatSession', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'connect-protocol-version': '1',
          'oasis-appid': '10200',
          'oasis-language': 'zh',
          'oasis-platform': 'web',
          'x-waf-client-type': 'fetch_sdk',
          'canary': 'false',
        },
        body: '{}',
      });
      const text = await r.text();
      return { status: r.status, body: text.slice(0, 300) };
    } catch (e) { return { error: e.message }; }
  }).catch(e => ({ error: e.message }));
  console.log('  CreateChatSession:', JSON.stringify(stepResult));

  // === Kimi: 测试 wreq-js 对比浏览器 ===
  console.log('\n=== Kimi refresh_token 测试 ===');
  let kimiPage = context.pages().find(p => p.url().includes('kimi.com'));
  if (!kimiPage) {
    kimiPage = await context.newPage();
    await kimiPage.goto('https://www.kimi.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await kimiPage.waitForTimeout(2000);
  }
  
  const refreshToken = await kimiPage.evaluate(() => localStorage.getItem('refresh_token'));
  console.log(`  refresh_token: ${refreshToken?.slice(0, 30)}...`);
  
  // 在浏览器中测试 refresh
  const kimiRefreshResult = await kimiPage.evaluate(async (rt) => {
    try {
      const r = await fetch('https://kimi.moonshot.cn/api/auth/token/refresh', {
        method: 'GET',
        headers: { Authorization: `Bearer ${rt}` },
      });
      return { status: r.status, body: (await r.text()).slice(0, 200) };
    } catch (e) { return { error: e.message }; }
  }, refreshToken);
  console.log('  浏览器 refresh 结果:', JSON.stringify(kimiRefreshResult));

  // === Doubao: 调试实际响应 ===
  console.log('\n=== Doubao 调试 ===');
  try {
    const sidecarRes = await fetch('http://127.0.0.1:8046/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'doubao',
        messages: [{ role: 'user', content: '你好' }],
        stream: true,
      }),
    });
    console.log(`  Status: ${sidecarRes.status}`);
    const text = await sidecarRes.text();
    console.log(`  Response: ${text.slice(0, 500)}`);
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }

  // === Metaso: 调试实际响应 ===
  console.log('\n=== Metaso 调试 ===');
  try {
    const sidecarRes = await fetch('http://127.0.0.1:8046/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'metaso',
        messages: [{ role: 'user', content: '你好' }],
        stream: true,
      }),
    });
    console.log(`  Status: ${sidecarRes.status}`);
    const text = await sidecarRes.text();
    console.log(`  Response: ${text.slice(0, 500)}`);
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }

  for (const p of [stepPage, kimiPage]) {
    if (!context.pages().some(existing => existing === p && p.url().includes('about:blank'))) continue;
    await p.close().catch(() => {});
  }
  browser.close();
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
