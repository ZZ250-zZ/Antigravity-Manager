#!/usr/bin/env node
/**
 * 集成测试：启动 sidecar 服务，注册 token，发送 OpenAI 格式请求验证端到端流程。
 *
 * 用法：
 *   node scripts/test-all.mjs                       # 测试所有已配置的 provider
 *   node scripts/test-all.mjs --provider qwen       # 只测试 qwen
 *   node scripts/test-all.mjs --non-stream           # 测试非流式
 *
 * 环境变量（按需设置）：
 *   QWEN_TOKEN   = tongyi_sso_ticket
 *   KIMI_TOKEN   = refresh_token
 *   ZHIPU_TOKEN  = chatglm_refresh_token
 *   DOUBAO_TOKEN = sessionid
 *   CN_PROVIDERS_PORT = 8046 (默认)
 */

const BASE = `http://127.0.0.1:${process.env.CN_PROVIDERS_PORT || '8046'}`;
const args = process.argv.slice(2);
const onlyProvider = args.includes('--provider') ? args[args.indexOf('--provider') + 1] : null;
const nonStream = args.includes('--non-stream');

// 自然测试问题，不暴露测试意图
const TEST_QUESTIONS = [
  '推荐一部最近好看的科幻电影呗',
  '帮我写一首关于春天的五言绝句',
  '用简单的话解释一下量子纠缠是什么',
  '北京有什么好吃的小吃推荐吗',
];

function randomQuestion() {
  return TEST_QUESTIONS[Math.floor(Math.random() * TEST_QUESTIONS.length)];
}

const TOKEN_MAP = {
  qwen: process.env.QWEN_TOKEN,
  kimi: process.env.KIMI_TOKEN,
  zhipu: process.env.ZHIPU_TOKEN,
  doubao: process.env.DOUBAO_TOKEN,
};

// 每个 provider 对应一个代表性 model
const PROVIDER_MODELS = {
  qwen: 'qwen-plus',
  kimi: 'kimi',
  zhipu: 'glm-4',
  doubao: 'doubao',
};

async function waitForServer(maxRetries = 15) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      // 还没启动
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function registerToken(provider, token) {
  const res = await fetch(`${BASE}/v1/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, token }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`注册 ${provider} token 失败: ${res.status} ${text}`);
  }
  return res.json();
}

async function testStreamChat(model) {
  const question = randomQuestion();
  console.log(`  问题: "${question}"`);
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: question }],
      stream: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    throw new Error(`期望 text/event-stream, 实际: ${contentType}`);
  }

  // 逐行读取 SSE
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let chunks = 0;
  let gotDone = false;

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
        gotDone = true;
        continue;
      }
      if (!payload) continue;
      try {
        const obj = JSON.parse(payload);
        // 验证 OpenAI 格式
        if (obj.object !== 'chat.completion.chunk') {
          console.warn(`  ⚠ 非标准 object: ${obj.object}`);
        }
        const delta = obj.choices?.[0]?.delta;
        if (delta?.content) {
          fullText += delta.content;
          chunks++;
        }
        if (obj.choices?.[0]?.finish_reason === 'stop') {
          // 正常结束
        }
      } catch {
        // ignore
      }
    }
  }

  return { fullText, chunks, gotDone };
}

async function testNonStreamChat(model) {
  const question = randomQuestion();
  console.log(`  问题: "${question}"`);
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: question }],
      stream: false,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  return { fullText: content, object: data.object };
}

async function main() {
  console.log('=== CN Providers Sidecar 集成测试 ===\n');

  // 检查服务是否运行
  console.log(`检查服务 (${BASE})...`);
  const alive = await waitForServer(5);
  if (!alive) {
    console.log('❌ 服务未启动！请先运行: node src/index.mjs');
    console.log('   或使用环境变量预设 token: QWEN_TOKEN=xxx node src/index.mjs');
    process.exit(1);
  }
  console.log('✅ 服务已运行\n');

  // 注册 token
  const providers = Object.entries(TOKEN_MAP)
    .filter(([name, token]) => token && (!onlyProvider || onlyProvider === name));

  if (providers.length === 0) {
    console.log('❌ 没有可测试的 provider。请设置环境变量：');
    console.log('   QWEN_TOKEN=xxx KIMI_TOKEN=xxx ZHIPU_TOKEN=xxx DOUBAO_TOKEN=xxx');
    process.exit(1);
  }

  for (const [name, token] of providers) {
    await registerToken(name, token);
    console.log(`✓ 注册 ${name} token`);
  }
  console.log('');

  // 列出模型
  const modelsRes = await fetch(`${BASE}/v1/models`);
  const modelsData = await modelsRes.json();
  console.log(`可用模型: ${modelsData.data.map((m) => m.id).join(', ')}\n`);

  // 逐个 provider 测试
  const results = [];
  for (const [name] of providers) {
    const model = PROVIDER_MODELS[name];
    console.log(`========== ${name} (model: ${model}) ==========`);
    try {
      if (nonStream) {
        console.log('  模式: 非流式');
        const { fullText, object } = await testNonStreamChat(model);
        console.log(`  object: ${object}`);
        console.log(`  回复 (前100字): ${fullText.slice(0, 100)}...`);
        results.push({ name, status: '✅', detail: fullText.slice(0, 60) });
      } else {
        console.log('  模式: 流式 (SSE)');
        const { fullText, chunks, gotDone } = await testStreamChat(model);
        console.log(`  SSE chunks: ${chunks}`);
        console.log(`  收到 [DONE]: ${gotDone ? '是' : '否'}`);
        console.log(`  回复 (前100字): ${fullText.slice(0, 100)}...`);
        if (!fullText) throw new Error('回复内容为空');
        if (!gotDone) console.warn('  ⚠ 未收到 [DONE] 标记');
        results.push({ name, status: '✅', detail: fullText.slice(0, 60) });
      }
    } catch (err) {
      console.error(`  ❌ 失败: ${err.message}`);
      results.push({ name, status: '❌', detail: err.message.slice(0, 60) });
    }
    console.log('');
  }

  // 汇总
  console.log('========== 测试结果汇总 ==========');
  console.log('| Provider | 状态 | 说明 |');
  console.log('|----------|------|------|');
  for (const r of results) {
    console.log(`| ${r.name.padEnd(8)} | ${r.status}   | ${r.detail} |`);
  }

  const failed = results.filter((r) => r.status === '❌');
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('测试脚本异常:', e);
  process.exit(1);
});
