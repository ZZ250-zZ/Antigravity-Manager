/**
 * 各 Provider 原始 SSE 流 → OpenAI Chat Completion Streaming 格式（纯胶水层）。
 *
 * 核心思路：用 TransformStream 逐行解析上游 SSE data，通过注册表分发到
 * 各 provider 的解析方法，输出 OpenAI `chat.completion.chunk` JSON，
 * 最终发 [DONE]。
 *
 * Provider 差异化逻辑已下沉到各 provider 文件中，通过 sse-registry 注册。
 */

import { randomUUID } from 'node:crypto';
import { getSSEProcessor } from './sse-registry.mjs';

/**
 * @param {string} providerName  qwen | kimi | zhipu | doubao | ...
 * @param {string} model         请求时的 model 名
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createOpenAIStreamTransformer(providerName, model) {
  const chatId = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const processor = getSSEProcessor(providerName);
  // provider 自定义状态（prevContent 用于全文→增量 delta 计算）
  const state = { prevContent: '' };
  let sseBuffer = '';
  let sentFirstRole = false;
  let finished = false;

  /** 把一个 OpenAI chunk 对象序列化为 SSE 行 */
  function encodeChunk(delta, finishReason = null) {
    const obj = {
      id: chatId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    return encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);
  }

  /** 发送 role + stop + [DONE] 的结束序列 */
  function emitFinish(controller) {
    finished = true;
    controller.enqueue(encodeChunk({}, 'stop'));
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
  }

  /** 处理单条 SSE payload（data: 后的内容） */
  function processPayload(payload, controller) {
    if (payload === '[DONE]') {
      emitFinish(controller);
      return true;
    }
    if (!payload) return false;

    // raw payload 模式（如 Spark base64）：不经过 JSON 解析
    if (processor?.isRawPayload && processor.processRawPayload) {
      const result = processor.processRawPayload(payload, state);
      if (!result) return false;
      if (result.done) { emitFinish(controller); return true; }
      if (result.content) {
        if (!sentFirstRole) {
          sentFirstRole = true;
          controller.enqueue(encodeChunk({ role: 'assistant', content: '' }));
        }
        controller.enqueue(encodeChunk({ content: result.content }));
      }
      return false;
    }

    // 标准 JSON 解析路径
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return false;
    }

    if (!sentFirstRole) {
      sentFirstRole = true;
      controller.enqueue(encodeChunk({ role: 'assistant', content: '' }));
    }

    // 检查流结束标志
    if (processor?.isDone?.(parsed)) {
      emitFinish(controller);
      return true;
    }

    // 提取增量文本
    const delta = processor?.extractDelta?.(parsed, state) ?? null;
    if (delta) {
      controller.enqueue(encodeChunk({ content: delta }));
    }
    return false;
  }

  return new TransformStream({
    transform(chunk, controller) {
      if (finished) return;
      const rawText = decoder.decode(chunk, { stream: true });
      sseBuffer += rawText;
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '').trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trimStart();
        if (processPayload(payload, controller)) return;
      }
    },
    flush(controller) {
      if (sseBuffer.trim()) {
        const line = sseBuffer.trim();
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trimStart();
          if (payload && payload !== '[DONE]') {
            processPayload(payload, controller);
          }
        }
      }
      if (!finished) {
        emitFinish(controller);
      }
    },
  });
}

/**
 * 非流式模式：收集完整回复后返回标准 OpenAI ChatCompletion 响应。
 * @param {ReadableStream<Uint8Array>} stream  provider 原始 SSE 流
 * @param {string} providerName
 * @param {string} model
 * @returns {Promise<object>}
 */
export async function collectNonStreamResponse(stream, providerName, model) {
  const processor = getSSEProcessor(providerName);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '').trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trimStart();
      if (payload === '[DONE]' || !payload) continue;

      // raw payload 模式
      if (processor?.isRawPayload && processor.processRawPayload) {
        const state = {};
        const result = processor.processRawPayload(payload, state);
        if (result?.done) break;
        if (result?.content) fullContent += result.content;
        continue;
      }

      try {
        const parsed = JSON.parse(payload);
        if (processor?.extractFullContent) {
          fullContent = processor.extractFullContent(parsed, fullContent);
        }
      } catch {
        // ignore
      }
    }
  }

  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: fullContent },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
