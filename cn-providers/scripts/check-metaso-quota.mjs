#!/usr/bin/env node
/**
 * 检查 Metaso 账号配额
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  let page = context.pages().find(p => p.url().includes('metaso'));
  if (!page) {
    page = await context.newPage();
    await page.goto('https://metaso.cn/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
  }

  const result = await page.evaluate(async () => {
    const apis = ['/api/advance-usage', '/api/my-info'];
    const results = {};
    for (const api of apis) {
      try {
        const r = await fetch(api);
        results[api] = { status: r.status, data: await r.json() };
      } catch (e) {
        results[api] = { error: e.message };
      }
    }
    return results;
  });

  for (const [api, data] of Object.entries(result)) {
    console.log(`\n=== ${api} ===`);
    console.log(JSON.stringify(data, null, 2).slice(0, 2000));
  }

  browser.close();
}

main().catch(e => console.error(e.message));
