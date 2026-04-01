#!/usr/bin/env node
/**
 * 抓取 Qwen 搜索查询的原始 SSE 数据
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  // 从 CDP 获取 token
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const cookies = await context.cookies();
  const qwenToken = cookies.find(c => c.name === 'tongyi_sso_ticket')?.value;
  browser.close();
  
  if (!qwenToken) {
    console.log('没有 Qwen token');
    return;
  }

  console.log('=== Qwen 原始 SSE 数据 ===\n');
  
  const { QwenProvider } = await import('../src/providers/qwen.mjs');
  const provider = new QwenProvider(qwenToken);
  
  const result = await provider.chatCompletion(
    [{ role: 'user', content: '推荐一部最近好看的科幻电影' }],
    { model: 'qwen-plus' }
  );

  const reader = result.stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let chunkCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trimStart();
      if (payload === '[DONE]') {
        console.log('\n[DONE]');
        continue;
      }
      if (!payload) continue;
      
      chunkCount++;
      try {
        const obj = JSON.parse(payload);
        const keys = Object.keys(obj);
        const hasContents = Array.isArray(obj.contents);
        const contentType = obj.contents?.[0]?.contentType;
        const content = obj.contents?.[0]?.content;
        
        console.log(`[${chunkCount}] keys=${keys.join(',')}`);
        if (hasContents) {
          console.log(`  contentType: ${contentType}`);
          console.log(`  content: ${JSON.stringify(content)?.slice(0, 200)}`);
        }
        if (obj.content !== undefined) {
          console.log(`  .content: ${JSON.stringify(obj.content)?.slice(0, 200)}`);
        }
        if (obj.msgStatus) console.log(`  msgStatus: ${obj.msgStatus}`);
        if (obj.stopReason) console.log(`  stopReason: ${obj.stopReason}`);
        console.log('');
      } catch (e) {
        console.log(`[${chunkCount}] RAW: ${payload.slice(0, 150)}`);
      }
      
      if (chunkCount > 20) {
        console.log('... (truncated, showing first 20 chunks only)');
        reader.releaseLock();
        return;
      }
    }
  }

  console.log(`\n总计 ${chunkCount} chunks`);
}

main().catch(e => console.error(e.message));
