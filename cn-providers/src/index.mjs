/**
 * CN Providers Sidecar 入口：Express 服务器，接收 OpenAI 格式请求并转发到各 Provider。
 *
 * 路由：
 *   POST /v1/chat/completions   — 主聊天端点，兼容 OpenAI API
 *   GET  /v1/models             — 列出可用模型
 *   POST /v1/tokens             — 注册 provider token
 *   DELETE /v1/tokens            — 移除 provider token
 *   GET  /health                — 健康检查
 */

import express from 'express';
import { config } from './config.mjs';
import { ProviderRouter } from './router.mjs';
import { ConversationTracker } from './utils/conversation-tracker.mjs';
import { createOpenAIStreamTransformer, collectNonStreamResponse } from './converters/native-to-openai.mjs';
import { getValidTokens, updateToken, batchUpdateTokens, STORE_FILE } from './utils/token-store.mjs';

const app = express();
app.use(express.json({ limit: '100mb' }));

const router = new ProviderRouter();
const tracker = new ConversationTracker();

// ─── 健康检查 ────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', providers: router.status() });
});

// ─── 列出可用模型 ────────────────────────────────────────
app.get('/v1/models', (_req, res) => {
  res.json({ object: 'list', data: router.listModels() });
});

// ─── Token 管理 ──────────────────────────────────────────
app.post('/v1/tokens', async (req, res) => {
  const { provider, token } = req.body ?? {};
  if (!provider || !token) {
    return res.status(400).json({ error: { message: '需要 provider 和 token 字段' } });
  }
  try {
    router.addToken(provider, token);
    // 持久化保存到本地文件
    await updateToken(provider, token).catch(() => {});
    res.json({ ok: true, providers: router.status() });
  } catch (e) {
    res.status(400).json({ error: { message: e.message } });
  }
});

app.delete('/v1/tokens', (req, res) => {
  const { provider, token } = req.body ?? {};
  if (!provider || !token) {
    return res.status(400).json({ error: { message: '需要 provider 和 token 字段' } });
  }
  router.removeToken(provider, token);
  res.json({ ok: true, providers: router.status() });
});

// ─── 主聊天端点 ──────────────────────────────────────────
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, stream: wantStream = true } = req.body ?? {};

    if (!model || !messages || !Array.isArray(messages)) {
      return res.status(400).json({
        error: { message: '请求需要 model 和 messages 字段', type: 'invalid_request_error' },
      });
    }

    const resolved = router.resolve(model);
    if (!resolved) {
      return res.status(404).json({
        error: {
          message: `模型 "${model}" 不可用。可能未注册 token 或模型名称无效。`,
          type: 'invalid_request_error',
        },
      });
    }

    const { provider, providerName } = resolved;
    console.log(`[${new Date().toISOString()}] ${providerName}/${model} ← ${messages.length} messages`);

    const result = await provider.chatCompletion(messages, {
      model,
      stream: true,
      tracker,
    });

    const { stream: providerStream, conversationId, _isOpenAIFormat, _idPromise } = result;

    if (!wantStream) {
      // 非流式：收集完整回复后返回
      const nameForParser = _isOpenAIFormat ? '_openai_compat' : providerName;
      const response = await collectNonStreamResponse(providerStream, nameForParser, model);
      // _idPromise 提供的 ID 会在 provider 内部通过 tracker 自动处理
      const cleanupId = _idPromise ? await _idPromise : conversationId;
      cleanupLater(cleanupId);
      return res.json(response);
    }

    // 流式响应
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // 官方 API 模式的 Provider 已返回 OpenAI 格式，无需转换
    const finalStream = _isOpenAIFormat
      ? providerStream
      : providerStream.pipeThrough(createOpenAIStreamTransformer(providerName, model));
    const reader = finalStream.getReader();

    // 持续读取转换后的 SSE 片段并写入 HTTP 响应
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.destroyed) res.write(value);
        }
      } catch (pumpErr) {
        // 上游读取异常（如连接中断），记录但不抛出
        console.error(`[SSE pump error] ${pumpErr.message ?? pumpErr}`);
      } finally {
        if (!res.destroyed) res.end();
        const cleanupId = _idPromise ? await _idPromise : conversationId;
        cleanupLater(cleanupId);
      }
    };

    // 客户端断开时取消上游读取
    req.on('close', () => {
      reader.cancel().catch(() => {});
    });

    await pump();
  } catch (err) {
    console.error(`[ChatCompletion Error]`, err);
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: err instanceof Error ? err.message : String(err),
          type: 'server_error',
        },
      });
    }
  }
});

/** 流结束后延迟清理会话（不阻塞响应） */
function cleanupLater(conversationId) {
  if (!conversationId) return;
  setTimeout(() => {
    tracker.cleanup(conversationId).catch((e) => {
      console.warn(`[Cleanup] ${conversationId} 失败:`, e.message ?? e);
    });
  }, 2000);
}

// ─── 优雅退出 ────────────────────────────────────────────
async function gracefulShutdown() {
  console.log('\n正在清理会话...');
  await tracker.cleanupAll();
  console.log('清理完成，退出。');
  process.exit(0);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// ─── 启动 ────────────────────────────────────────────────
app.listen(config.port, async () => {
  console.log(`CN Providers Sidecar 已启动: http://127.0.0.1:${config.port}`);
  console.log(`聊天端点: POST http://127.0.0.1:${config.port}/v1/chat/completions`);
  console.log(`模型列表: GET  http://127.0.0.1:${config.port}/v1/models`);
  console.log(`Token 注册: POST http://127.0.0.1:${config.port}/v1/tokens  { provider, token }`);

  // 从本地持久化文件加载已保存的 token
  try {
    const savedTokens = await getValidTokens();
    const savedCount = Object.keys(savedTokens).length;
    if (savedCount > 0) {
      for (const [providerName, token] of Object.entries(savedTokens)) {
        try {
          router.addToken(providerName, token);
          console.log(`  ✓ 从本地加载 ${providerName} token`);
        } catch (e) {
          console.log(`  ✗ 加载 ${providerName} token 失败: ${e.message}`);
        }
      }
      console.log(`  共从 ${STORE_FILE} 加载了 ${savedCount} 个 token`);
    }
  } catch (e) {
    console.log(`  加载本地 token 失败: ${e.message}`);
  }

  // 如果环境变量中有预设的 token，自动注册（覆盖本地文件）
  const envTokens = {
    QWEN_TOKEN: 'qwen',
    KIMI_TOKEN: 'kimi',
    ZHIPU_TOKEN: 'zhipu',
    DOUBAO_TOKEN: 'doubao',
    DEEPSEEK_TOKEN: 'deepseek',
    HAILUO_TOKEN: 'hailuo',
    STEP_TOKEN: 'step',
    SPARK_TOKEN: 'spark',
    METASO_TOKEN: 'metaso',
    YUANBAO_TOKEN: 'yuanbao',
    MOMI_TOKEN: 'momi',
  };
  for (const [envKey, providerName] of Object.entries(envTokens)) {
    const val = process.env[envKey];
    if (val) {
      router.addToken(providerName, val);
      console.log(`  ✓ 从环境变量 ${envKey} 注册了 ${providerName} token`);
    }
  }
});

export { app, router, tracker };
