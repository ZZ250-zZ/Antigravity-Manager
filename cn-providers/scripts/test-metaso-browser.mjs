#!/usr/bin/env node
/**
 * 通过浏览器上下文直接测试 Metaso 新 API
 */
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];

  // 在 metaso 页面上执行 fetch
  let page;
  const pages = context.pages();
  page = pages.find(p => p.url().includes('metaso'));
  if (!page) {
    page = await context.newPage();
    await page.goto('https://metaso.cn/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
  }
  console.log('使用页面:', page.url());

  const conversationId = `temp-${randomUUID()}`;
  const result = await page.evaluate(async (cid) => {
    function uuid() {
      return 'temp-' + crypto.randomUUID();
    }
    const body = {
      model: 'concise',
      stream: true,
      messages: [{
        id: uuid(),
        key: uuid(),
        conversationId: cid,
        role: 'user',
        content: '1+1等于几',
        markdownContent: '1+1等于几',
        engineType: '',
        filter: 'all',
        contentType: 0,
        outputHtml: false,
        mode: 'detail',
        model: 'concise',
        outputStyle: '正常',
      }],
      engineType: '',
      mode: 'concise',
      filter: 'all',
      outputHtml: false,
      outputStyle: '正常',
      darkMode: false,
    };

    const res = await fetch('/api/search/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const chunks = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const p = t.slice(5).trim();
        if (p === '[DONE]') { chunks.push({ type: 'DONE' }); continue; }
        if (!p) continue;
        try {
          chunks.push(JSON.parse(p));
        } catch {
          chunks.push({ raw: p.slice(0, 200) });
        }
        if (chunks.length > 100) break;
      }
      if (chunks.length > 100) break;
    }

    return { status: res.status, chunksCount: chunks.length, chunks };
  }, conversationId);

  console.log('Status:', result.status);
  console.log('Chunks:', result.chunksCount);

  for (let i = 0; i < Math.min(result.chunks.length, 50); i++) {
    const chunk = result.chunks[i];
    console.log(`\n[${i + 1}] type: ${chunk.type ?? 'N/A'}`);
    if (chunk.data !== undefined) console.log(`  data: ${JSON.stringify(chunk.data).slice(0, 300)}`);
    if (chunk.msg !== undefined) console.log(`  msg: ${chunk.msg}`);
    if (chunk.code !== undefined) console.log(`  code: ${chunk.code}`);
    if (chunk.raw) console.log(`  raw: ${chunk.raw}`);
    // 完整打印小 chunk
    const full = JSON.stringify(chunk);
    if (full.length < 500) console.log(`  FULL: ${full}`);
  }

  // 不关闭 page（可能是之前打开的 metaso tab）
  browser.close();
}

main().catch(e => console.error(e.message));
