/**
 * 诊断 Kimi 的认证状态：列出所有相关 Cookie 和 localStorage
 */
import { chromium } from 'playwright';

async function main() {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = b.contexts()[0];
  
  // 1. 列出所有 kimi/moonshot 域的 Cookie
  const cookies = await ctx.cookies();
  const kimiCookies = cookies.filter(c => 
    c.domain.includes('kimi') || c.domain.includes('moonshot')
  );
  console.log(`=== Kimi/Moonshot 域 Cookie (${kimiCookies.length} 项) ===`);
  for (const c of kimiCookies) {
    console.log(`  ${c.domain} | ${c.name} = ${c.value.slice(0, 40)}... (expires: ${c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'session'})`);
  }
  
  // 2. 检查 kimi.com 页面的 localStorage
  let page = ctx.pages().find(p => {
    try { return new URL(p.url()).hostname.includes('kimi'); } catch { return false; }
  });
  let needClose = false;
  if (!page) {
    page = await ctx.newPage();
    needClose = true;
    await page.goto('https://www.kimi.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);
  }
  
  console.log('\n=== kimi.com localStorage ===');
  const lsKeys = await page.evaluate(() => {
    const result = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const val = localStorage.getItem(key);
      result[key] = val?.slice(0, 60) + (val?.length > 60 ? '...' : '');
    }
    return result;
  });
  for (const [k, v] of Object.entries(lsKeys)) {
    console.log(`  ${k} = ${v}`);
  }
  
  // 3. 尝试直接调用 Kimi API 看认证状态
  console.log('\n=== Kimi API 认证测试 ===');
  const apiResult = await page.evaluate(async () => {
    try {
      const res = await fetch('https://kimi.moonshot.cn/api/user', {
        credentials: 'include',
      });
      return { status: res.status, body: await res.text().then(t => t.slice(0, 200)) };
    } catch (e) {
      return { error: e.message };
    }
  });
  console.log('  /api/user:', JSON.stringify(apiResult));
  
  if (needClose) await page.close();
  b.close();
}

main().catch(e => { console.error(e); process.exit(1); });
