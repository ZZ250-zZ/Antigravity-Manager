#!/usr/bin/env node
/**
 * 直接调试 Metaso API - 绕过 sidecar
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const cookies = await context.cookies();

  // Metaso cookies
  const metasoCookies = cookies.filter(c => c.domain.includes('metaso.cn'));
  console.log('Metaso Cookies:');
  for (const c of metasoCookies) {
    console.log(`  ${c.name} = ${c.value.slice(0, 30)}... (domain: ${c.domain})`);
  }

  const uid = metasoCookies.find(c => c.name === 'uid')?.value;
  const sid = metasoCookies.find(c => c.name === 'sid')?.value;
  console.log(`\nuid: ${uid?.slice(0, 30)}`);
  console.log(`sid: ${sid?.slice(0, 30)}`);

  // 在浏览器中测试 Metaso API
  let page = context.pages().find(p => p.url().includes('metaso.cn'));
  let needClose = false;
  if (!page) {
    page = await context.newPage();
    needClose = true;
    await page.goto('https://metaso.cn/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
  }
  console.log('\n页面 URL:', page.url());

  // 在浏览器上下文中直接调用 API
  const result = await page.evaluate(async () => {
    try {
      const r = await fetch('https://metaso.cn/api/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          question: '你好',
          mode: 'concise',
        }),
      });
      
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let chunks = 0;
      const sseData = [];
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        chunks++;
      }
      
      // 解析 SSE 数据
      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data:')) {
          sseData.push(trimmed.slice(5).trimStart().slice(0, 200));
        } else if (trimmed.startsWith('event:')) {
          sseData.push(`[EVENT] ${trimmed}`);
        }
      }
      
      return { status: r.status, chunks, sseData: sseData.slice(0, 20), rawLength: text.length, rawSample: text.slice(0, 500) };
    } catch (e) { return { error: e.message }; }
  });
  
  console.log('\n浏览器 API 调用结果:');
  console.log(`  Status: ${result.status}`);
  console.log(`  Chunks: ${result.chunks}`);
  console.log(`  Raw 长度: ${result.rawLength}`);
  console.log(`  Raw 示例: ${result.rawSample?.slice(0, 500)}`);
  console.log(`  SSE 数据 (前20条):`);
  for (const d of result.sseData || []) {
    console.log(`    ${d}`);
  }

  if (needClose) await page.close();
  browser.close();
}

main().catch(e => console.error(e.message));
