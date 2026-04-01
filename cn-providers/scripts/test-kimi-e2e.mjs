#!/usr/bin/env node
/**
 * 单独测试 Kimi 端到端
 */
async function main() {
  const base = 'http://127.0.0.1:8046';
  console.log('=== Kimi E2E 测试 ===\n');

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'kimi',
      messages: [{ role: 'user', content: '你好，用一句话介绍一下你自己' }],
      stream: true,
    }),
  });

  console.log('Status:', res.status);
  
  if (!res.ok) {
    const text = await res.text();
    console.log('Error:', text.slice(0, 500));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let chunks = 0;

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
      if (payload === '[DONE]') continue;
      if (!payload) continue;
      try {
        const obj = JSON.parse(payload);
        const delta = obj.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          chunks++;
          process.stdout.write(delta);
        }
      } catch { /* ignore */ }
    }
  }

  console.log(`\n\n✅ ${chunks} chunks, 总长: ${fullText.length} 字符`);
}

main().catch(e => console.error('Error:', e.message));
