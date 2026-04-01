#!/usr/bin/env node
/**
 * 全量端到端测试：对每个已注册的 Provider 发送一次请求并验证
 */

const BASE = 'http://127.0.0.1:8046';

const TESTS = [
  { model: 'qwen-plus', name: 'Qwen' },
  { model: 'kimi', name: 'Kimi' },
  { model: 'deepseek', name: 'DeepSeek' },
  { model: 'momi', name: 'MOMI' },
  { model: 'doubao', name: 'Doubao' },
  { model: 'step', name: 'Step' },
  { model: 'zhipu', name: 'Zhipu' },
  { model: 'metaso', name: 'Metaso' },
  { model: 'spark', name: 'Spark' },
  { model: 'yuanbao', name: 'Yuanbao' },
];

const QUESTIONS = [
  '用一句话说说今天天气怎么样',
  '1加2等于多少？一句话回答',
  '你是什么模型？一句话介绍',
  '讲个一句话笑话',
  '北京在哪个省？一句话回答',
];

async function testProvider(test, question) {
  const start = Date.now();
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: test.model,
        messages: [{ role: 'user', content: question }],
        stream: true,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { name: test.name, status: 'FAIL', error: `HTTP ${res.status}: ${errText.slice(0, 100)}`, ms: Date.now() - start };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let text = '';
    let chunks = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) {
        const t = l.trim();
        if (!t.startsWith('data:')) continue;
        const p = t.slice(5).trim();
        if (p === '[DONE]') continue;
        if (!p) continue;
        chunks++;
        try {
          const o = JSON.parse(p);
          const c = o.choices?.[0]?.delta?.content;
          if (c) text += c;
        } catch { /* ignore */ }
      }
    }

    const ms = Date.now() - start;
    if (text.length > 0) {
      return { name: test.name, status: 'OK', chunks, text: text.slice(0, 80), ms };
    } else {
      return { name: test.name, status: 'EMPTY', chunks, ms };
    }
  } catch (e) {
    return { name: test.name, status: 'ERROR', error: e.message?.slice(0, 100), ms: Date.now() - start };
  }
}

async function main() {
  // 先检查 sidecar 是否运行
  try {
    const health = await fetch(`${BASE}/health`);
    const data = await health.json();
    console.log('Sidecar 状态:', JSON.stringify(data.providers));
  } catch {
    console.log('Sidecar 未运行！请先启动 node src/index.mjs');
    process.exit(1);
  }

  console.log('\n=== 全量端到端测试 ===\n');

  const results = [];
  for (let i = 0; i < TESTS.length; i++) {
    const test = TESTS[i];
    const question = QUESTIONS[i % QUESTIONS.length];
    process.stdout.write(`[${i + 1}/${TESTS.length}] ${test.name} (${test.model})... `);
    const result = await testProvider(test, question);
    results.push(result);

    if (result.status === 'OK') {
      console.log(`✅ ${result.chunks}chunks ${result.ms}ms "${result.text}"`);
    } else if (result.status === 'EMPTY') {
      console.log(`⚠️ 空响应 ${result.chunks}chunks ${result.ms}ms`);
    } else {
      console.log(`❌ ${result.status} ${result.ms}ms ${result.error ?? ''}`);
    }

    // 请求间隔 2s
    if (i < TESTS.length - 1) await new Promise(r => setTimeout(r, 2000));
  }

  console.log('\n=== 测试汇总 ===');
  const ok = results.filter(r => r.status === 'OK').length;
  const fail = results.filter(r => r.status !== 'OK').length;
  console.log(`通过: ${ok}/${results.length}`);
  if (fail > 0) {
    console.log('失败:');
    for (const r of results.filter(r => r.status !== 'OK')) {
      console.log(`  ${r.name}: ${r.status} ${r.error ?? ''}`);
    }
  }
}

main().catch(e => console.error(e.message));
