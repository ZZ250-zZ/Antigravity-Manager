#!/usr/bin/env node
/**
 * 调试 Kimi 认证 - 查看所有 cookie 和 localStorage
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const cookies = await context.cookies();

  // Kimi 相关 cookies
  const kimiCookies = cookies.filter(c => 
    c.domain.includes('moonshot') || c.domain.includes('kimi')
  );
  console.log('=== Kimi Cookies ===');
  for (const c of kimiCookies) {
    console.log(`  ${c.name} = ${c.value.slice(0, 40)}... (domain: ${c.domain})`);
  }

  // localStorage
  let page = context.pages().find(p => p.url().includes('kimi.com'));
  let needClose = false;
  if (!page) {
    page = await context.newPage();
    needClose = true;
    await page.goto('https://www.kimi.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
  }

  const ls = await page.evaluate(() => {
    const items = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const val = localStorage.getItem(key);
      items[key] = val?.slice(0, 60) + (val?.length > 60 ? '...' : '');
    }
    return items;
  });
  
  console.log('\n=== Kimi localStorage ===');
  for (const [k, v] of Object.entries(ls)) {
    if (k.includes('token') || k.includes('auth') || k.includes('refresh') || k.includes('access')) {
      console.log(`  ★ ${k} = ${v}`);
    } else {
      console.log(`  ${k} = ${v}`);
    }
  }

  // 测试 kimi-auth cookie 作为 Bearer token 直接调用 API
  const kimiAuthCookie = kimiCookies.find(c => c.name === 'kimi-auth');
  if (kimiAuthCookie) {
    console.log('\n=== 测试 kimi-auth 作为 access_token ===');
    const testResult = await page.evaluate(async (token) => {
      // 直接用 kimi-auth 作为 Bearer token
      try {
        const r = await fetch('https://kimi.moonshot.cn/api/user', {
          headers: { Authorization: `Bearer ${token}` },
        });
        return { status: r.status, body: (await r.text()).slice(0, 300) };
      } catch (e) { return { error: e.message }; }
    }, kimiAuthCookie.value);
    console.log('  /api/user:', JSON.stringify(testResult));

    // 测试 refresh
    const refreshResult = await page.evaluate(async (token) => {
      try {
        const r = await fetch('https://kimi.moonshot.cn/api/auth/token/refresh', {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        });
        return { status: r.status, body: (await r.text()).slice(0, 300) };
      } catch (e) { return { error: e.message }; }
    }, kimiAuthCookie.value);
    console.log('  /api/auth/token/refresh:', JSON.stringify(refreshResult));
  }

  // 测试 access_token from localStorage
  const accessToken = await page.evaluate(() => localStorage.getItem('access_token'));
  const refreshToken = await page.evaluate(() => localStorage.getItem('refresh_token'));
  
  if (refreshToken) {
    console.log('\n=== 测试 refresh_token from localStorage ===');
    const refreshResult = await page.evaluate(async (token) => {
      try {
        const r = await fetch('https://kimi.moonshot.cn/api/auth/token/refresh', {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        });
        return { status: r.status, body: (await r.text()).slice(0, 300) };
      } catch (e) { return { error: e.message }; }
    }, refreshToken);
    console.log('  结果:', JSON.stringify(refreshResult));
  }

  if (accessToken) {
    console.log('\n=== 测试 access_token from localStorage ===');
    const userResult = await page.evaluate(async (token) => {
      try {
        const r = await fetch('https://kimi.moonshot.cn/api/user', {
          headers: { Authorization: `Bearer ${token}` },
        });
        return { status: r.status, body: (await r.text()).slice(0, 300) };
      } catch (e) { return { error: e.message }; }
    }, accessToken);
    console.log('  /api/user:', JSON.stringify(userResult));
  }

  if (needClose) await page.close();
  browser.close();
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
