#!/usr/bin/env node
/**
 * 调试 Metaso 和 Qwen 的原始 SSE 响应
 */

const SIDECAR = 'http://127.0.0.1:8046';

async function testRaw(model, question) {
  console.log(`\n=== ${model} 原始 SSE ===`);
  const res = await fetch(`${SIDECAR}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: question }],
      stream: true,
    }),
  });
  
  console.log(`Status: ${res.status}`);
  if (!res.ok) {
    console.log('Error:', (await res.text()).slice(0, 300));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let chunkCount = 0;
  let fullText = '';
  
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
        console.log('  [DONE]');
        continue;
      }
      if (!payload) continue;
      
      chunkCount++;
      // 显示前10个和后3个 chunk 的完整数据
      if (chunkCount <= 10 || chunkCount > 50) {
        console.log(`  [${chunkCount}] ${payload.slice(0, 200)}`);
      } else if (chunkCount === 11) {
        console.log('  ... (省略中间 chunks) ...');
      }
      
      try {
        const obj = JSON.parse(payload);
        const delta = obj.choices?.[0]?.delta?.content;
        if (delta) fullText += delta;
      } catch {}
    }
  }
  
  console.log(`\n总计 ${chunkCount} chunks, 文本长度: ${fullText.length}`);
  if (fullText) {
    console.log(`回复前100字: ${fullText.slice(0, 100)}`);
  }
}

async function main() {
  await testRaw('metaso', '你好');
  await testRaw('qwen-plus', '你好');
}

main().catch(e => console.error(e.message));
