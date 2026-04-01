#!/usr/bin/env node
/**
 * 抓取 Qwen 搜索查询的原始 SSE 数据（绕过 sidecar 转换器）
 */
import { httpRequest } from '../src/http-client.mjs';

async function main() {
  // 从 sidecar 获取当前 token
  const tokensRes = await fetch('http://127.0.0.1:8046/v1/tokens');
  const tokens = await tokensRes.json();
  const qwenToken = tokens.find(t => t.provider === 'qwen')?.token;
  if (!qwenToken) {
    console.log('没有 Qwen token');
    return;
  }

  console.log('=== Qwen 原始 SSE 数据 ===\n');
  
  // 直接调用 Qwen API
  const { QwenProvider } = await import('../src/providers/qwen.mjs');
  const provider = new QwenProvider(qwenToken);
  
  const result = await provider.chatCompletion(
    [{ role: 'user', content: '推荐一部最近好看的科幻电影呗' }],
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
        // 显示完整结构
        const keys = Object.keys(obj);
        const hasContents = Array.isArray(obj.contents);
        const contentType = obj.contents?.[0]?.contentType;
        const content = obj.contents?.[0]?.content;
        
        console.log(`[${chunkCount}] keys=${keys.join(',')}`);
        if (hasContents) {
          console.log(`  contents[0].contentType: ${contentType}`);
          console.log(`  contents[0].content: ${JSON.stringify(content)?.slice(0, 200)}`);
        }
        if (obj.content !== undefined) {
          console.log(`  content: ${JSON.stringify(obj.content)?.slice(0, 200)}`);
        }
        if (obj.msgStatus) {
          console.log(`  msgStatus: ${obj.msgStatus}`);
        }
        if (obj.stopReason) {
          console.log(`  stopReason: ${obj.stopReason}`);
        }
        console.log('');
      } catch (e) {
        console.log(`[${chunkCount}] PARSE ERROR: ${payload.slice(0, 100)}`);
      }
    }
  }

  console.log(`\n总计 ${chunkCount} chunks`);
  
  // 清理对话
  if (result._idPromise) {
    const id = await result._idPromise;
    console.log(`对话 ID: ${id}`);
  }
}

main().catch(e => console.error(e));
