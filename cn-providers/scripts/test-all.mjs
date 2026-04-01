#!/usr/bin/env node
/**
 * 集成测试：连接 sidecar 服务，注册 token，发送 OpenAI 格式请求验证端到端流程。
 *
 * 用法：
 *   node scripts/test-all.mjs                       # 测试所有已配置的 provider
 *   node scripts/test-all.mjs --provider qwen       # 只测试 qwen
 *   node scripts/test-all.mjs --non-stream           # 测试非流式
 *   node scripts/test-all.mjs --infra-only           # 仅测试基础设施（不需要真实 token）
 *
 * 环境变量（按需设置，Web 模式用 Cookie/Token，API 模式用 API Key）：
 *   QWEN_TOKEN      = tongyi_sso_ticket
 *   KIMI_TOKEN      = refresh_token
 *   ZHIPU_TOKEN     = chatglm_refresh_token
 *   DOUBAO_TOKEN    = sessionid
 *   DEEPSEEK_TOKEN  = userToken
 *   HAILUO_TOKEN    = _token
 *   STEP_TOKEN      = Oasis-Token (或 deviceId@Oasis-Token)
 *   SPARK_TOKEN     = ssoSessionId
 *   METASO_TOKEN    = uid-sid
 *   YUANBAO_TOKEN   = Cookie 字符串
 *   BAICHUAN_API_KEY = API Key
 *   YI_API_KEY       = API Key
 *   SENSENOVA_API_KEY = API Key
 *   TIANGONG_API_KEY  = API Key
 *   CN_PROVIDERS_PORT = 8046 (默认)
 */

const BASE = `http://127.0.0.1:${process.env.CN_PROVIDERS_PORT || '8046'}`;
const args = process.argv.slice(2);
const onlyProvider = args.includes('--provider') ? args[args.indexOf('--provider') + 1] : null;
const nonStream = args.includes('--non-stream');
const infraOnly = args.includes('--infra-only');

// 自然测试问题，不暴露测试意图
const TEST_QUESTIONS = [
  '推荐一部最近好看的科幻电影呗',
  '帮我写一首关于春天的五言绝句',
  '用简单的话解释一下量子纠缠是什么',
  '北京有什么好吃的小吃推荐吗',
  '你觉得猫和狗哪个更适合当宠物',
  '周末适合去哪里爬山呢',
];

function randomQuestion() {
  return TEST_QUESTIONS[Math.floor(Math.random() * TEST_QUESTIONS.length)];
}

// 所有 Provider 的 Token 环境变量映射
const TOKEN_MAP = {
  // Web 模式
  qwen: process.env.QWEN_TOKEN,
  kimi: process.env.KIMI_TOKEN,
  zhipu: process.env.ZHIPU_TOKEN,
  doubao: process.env.DOUBAO_TOKEN,
  deepseek: process.env.DEEPSEEK_TOKEN,
  hailuo: process.env.HAILUO_TOKEN,
  step: process.env.STEP_TOKEN,
  spark: process.env.SPARK_TOKEN,
  metaso: process.env.METASO_TOKEN,
  yuanbao: process.env.YUANBAO_TOKEN,
  // 官方 API 模式已移除，仅保留 Web 免费模式
};

// 每个 provider 对应一个代表性 model
const PROVIDER_MODELS = {
  qwen: 'qwen-plus',
  kimi: 'kimi',
  zhipu: 'glm-4',
  doubao: 'doubao',
  deepseek: 'deepseek-chat',
  hailuo: 'hailuo',
  step: 'stepchat',
  spark: 'spark',
  metaso: 'metaso',
  yuanbao: 'yuanbao',
  // 官方 API 模式已移除
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

// ─── 基础设施测试（不需要真实 token） ─────────────────────
async function testInfrastructure() {
  console.log('=== 基础设施测试（无需真实 token） ===\n');
  const results = [];

  // 1. 健康检查
  try {
    const res = await fetch(`${BASE}/health`);
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(`status=${data.status}`);
    results.push({ name: '健康检查', status: '✅', detail: JSON.stringify(data) });
  } catch (e) { results.push({ name: '健康检查', status: '❌', detail: e.message }); }

  // 2. Token 注册
  try {
    const res = await fetch(`${BASE}/v1/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'qwen', token: 'test_infra_token' }),
    });
    const data = await res.json();
    if (!data.ok || data.providers?.qwen !== 1) throw new Error(`unexpected: ${JSON.stringify(data)}`);
    results.push({ name: 'Token 注册', status: '✅', detail: 'qwen token 注册成功' });
  } catch (e) { results.push({ name: 'Token 注册', status: '❌', detail: e.message }); }

  // 3. 模型列表
  try {
    const res = await fetch(`${BASE}/v1/models`);
    const data = await res.json();
    if (!data.data || !Array.isArray(data.data)) throw new Error('无效格式');
    const hasQwen = data.data.some((m) => m.id.startsWith('qwen'));
    if (!hasQwen) throw new Error('注册 qwen token 后未出现 qwen 模型');
    results.push({ name: '模型列表', status: '✅', detail: `${data.data.length} 个模型` });
  } catch (e) { results.push({ name: '模型列表', status: '❌', detail: e.message }); }

  // 4. 未知 Provider 注册
  try {
    const res = await fetch(`${BASE}/v1/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'nonexistent', token: 'x' }),
    });
    if (res.status !== 400) throw new Error(`期望 400, 实际 ${res.status}`);
    results.push({ name: '未知 Provider 注册', status: '✅', detail: '正确返回 400' });
  } catch (e) { results.push({ name: '未知 Provider 注册', status: '❌', detail: e.message }); }

  // 5. 缺少字段
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    if (res.status !== 400) throw new Error(`期望 400, 实际 ${res.status}`);
    results.push({ name: '缺少 model 字段', status: '✅', detail: '正确返回 400' });
  } catch (e) { results.push({ name: '缺少 model 字段', status: '❌', detail: e.message }); }

  // 6. 未知模型
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'unknown_model_xyz', messages: [{ role: 'user', content: 'hi' }] }),
    });
    if (res.status !== 404) throw new Error(`期望 404, 实际 ${res.status}`);
    results.push({ name: '未知模型', status: '✅', detail: '正确返回 404' });
  } catch (e) { results.push({ name: '未知模型', status: '❌', detail: e.message }); }

  // 7. Token 删除
  try {
    const res = await fetch(`${BASE}/v1/tokens`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'qwen', token: 'test_infra_token' }),
    });
    const data = await res.json();
    if (data.providers?.qwen !== 0 && data.providers?.qwen !== undefined) {
      throw new Error(`token 未清除: ${JSON.stringify(data.providers)}`);
    }
    results.push({ name: 'Token 删除', status: '✅', detail: 'qwen token 已删除' });
  } catch (e) { results.push({ name: 'Token 删除', status: '❌', detail: e.message }); }

  // 8. 删除后模型不可用
  try {
    const res = await fetch(`${BASE}/v1/models`);
    const data = await res.json();
    const hasQwen = data.data.some((m) => m.id.startsWith('qwen'));
    if (hasQwen) throw new Error('删除 token 后 qwen 模型仍然可用');
    results.push({ name: '删除后模型不可用', status: '✅', detail: 'qwen 模型已移除' });
  } catch (e) { results.push({ name: '删除后模型不可用', status: '❌', detail: e.message }); }

  // 9. 多 Provider 并行注册
  try {
    const providers = ['kimi', 'zhipu', 'doubao', 'deepseek'];
    for (const p of providers) {
      await registerToken(p, `test_token_${p}`);
    }
    const res = await fetch(`${BASE}/v1/models`);
    const data = await res.json();
    if (data.data.length < 10) throw new Error(`期望至少 10 个模型, 实际 ${data.data.length}`);
    results.push({ name: '多 Provider 注册', status: '✅', detail: `${data.data.length} 个模型` });
    // 清理
    for (const p of providers) {
      await fetch(`${BASE}/v1/tokens`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: p, token: `test_token_${p}` }),
      });
    }
  } catch (e) { results.push({ name: '多 Provider 注册', status: '❌', detail: e.message }); }

  return results;
}

async function main() {
  console.log('=== CN Providers Sidecar 集成测试 ===\n');

  // 检查服务是否运行
  console.log(`检查服务 (${BASE})...`);
  const alive = await waitForServer(5);
  if (!alive) {
    console.log('❌ 服务未启动！请先运行: node src/index.mjs');
    process.exit(1);
  }
  console.log('✅ 服务已运行\n');

  // 阶段一：基础设施测试
  const infraResults = await testInfrastructure();
  console.log('\n--- 基础设施测试结果 ---');
  for (const r of infraResults) {
    console.log(`  ${r.status} ${r.name}: ${r.detail}`);
  }
  const infraFailed = infraResults.filter((r) => r.status === '❌');
  if (infraFailed.length > 0) {
    console.log(`\n❌ ${infraFailed.length} 项基础设施测试失败`);
  } else {
    console.log(`\n✅ 全部 ${infraResults.length} 项基础设施测试通过`);
  }

  if (infraOnly) {
    process.exit(infraFailed.length > 0 ? 1 : 0);
  }

  // 阶段二：Provider 端到端测试
  console.log('\n=== Provider 端到端测试 ===\n');

  const providers = Object.entries(TOKEN_MAP)
    .filter(([name, token]) => token && (!onlyProvider || onlyProvider === name));

  if (providers.length === 0) {
    console.log('⚠ 没有配置真实 token 的 provider，跳过端到端测试。');
    console.log('  可设置环境变量：');
    console.log('  QWEN_TOKEN, KIMI_TOKEN, ZHIPU_TOKEN, DOUBAO_TOKEN,');
    console.log('  DEEPSEEK_TOKEN, HAILUO_TOKEN, STEP_TOKEN, SPARK_TOKEN,');
    console.log('  METASO_TOKEN, YUANBAO_TOKEN');
    process.exit(infraFailed.length > 0 ? 1 : 0);
  }

  for (const [name, token] of providers) {
    await registerToken(name, token);
    console.log(`✓ 注册 ${name} token`);
  }
  console.log('');

  const modelsRes = await fetch(`${BASE}/v1/models`);
  const modelsData = await modelsRes.json();
  console.log(`可用模型: ${modelsData.data.map((m) => m.id).join(', ')}\n`);

  const results = [];
  for (const [name] of providers) {
    const model = PROVIDER_MODELS[name];
    if (!model) {
      console.log(`⚠ 跳过 ${name}: 未定义代表性模型`);
      continue;
    }
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
  console.log('| Provider   | 状态 | 说明 |');
  console.log('|------------|------|------|');
  for (const r of results) {
    console.log(`| ${r.name.padEnd(10)} | ${r.status}   | ${r.detail} |`);
  }

  const allFailed = [...infraFailed, ...results.filter((r) => r.status === '❌')];
  process.exit(allFailed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('测试脚本异常:', e);
  process.exit(1);
});
