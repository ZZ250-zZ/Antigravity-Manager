/**
 * 各 Provider 原始 SSE 流 → OpenAI Chat Completion Streaming 格式。
 *
 * 核心思路：用 TransformStream 逐行解析上游 SSE data，提取增量文本，
 * 输出 OpenAI `chat.completion.chunk` JSON，最终发 [DONE]。
 *
 * 四家 Provider 的 SSE 内容差异：
 *   Qwen  : content 为全文（incremental=false），需自行算 delta
 *   Kimi  : event=cmpl 时 text 为增量
 *   智谱  : parts[0].content 为全文，需自行算 delta
 *   豆包  : event_data 为 JSON 字符串，内含增量文本
 */

import { randomUUID } from 'node:crypto';

/**
 * @param {string} providerName  qwen | kimi | zhipu | doubao
 * @param {string} model         请求时的 model 名
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createOpenAIStreamTransformer(providerName, model) {
  const chatId = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // 非增量 Provider（Qwen / 智谱）需要记录上一次全文长度来算 delta
  let prevContent = '';
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

  /** 提取各 Provider 的增量文本；返回 null 表示该行不含有效内容 */
  function extractDelta(parsed) {
    switch (providerName) {
      case 'qwen': {
        // incremental 通常为 false，content 是累积全文
        const full = typeof parsed.content === 'string' ? parsed.content : null;
        if (full === null) return null;
        const delta = full.slice(prevContent.length);
        prevContent = full;
        return delta || null;
      }
      case 'kimi': {
        // event=cmpl 时 text 为增量片段；event=all_done 时结束
        if (parsed.event === 'all_done') return null;
        if (parsed.event === 'cmpl' && typeof parsed.text === 'string') {
          return parsed.text;
        }
        return null;
      }
      case 'zhipu': {
        // parts[0].content 为累积全文
        const parts = parsed.parts;
        if (!Array.isArray(parts) || !parts.length) return null;
        const full = typeof parts[0].content === 'string' ? parts[0].content : null;
        if (full === null) return null;
        const delta = full.slice(prevContent.length);
        prevContent = full;
        return delta || null;
      }
      case 'doubao': {
        // event_data 是 JSON 字符串，内含回复文本
        const et = parsed.event_type;
        if (et === 2003) return null; // 结束标记
        if (et === 2005) return null; // 错误
        if (typeof parsed.event_data !== 'string') return null;
        try {
          const ed = JSON.parse(parsed.event_data);
          // 豆包 event_data 结构: { message: { content: { text } } } 或直接 { text }
          const text =
            ed?.message?.content?.text ??
            ed?.content?.text ??
            ed?.text ??
            null;
          if (typeof text !== 'string') return null;
          // 豆包也是全文模式，按 delta 计算
          const delta = text.slice(prevContent.length);
          prevContent = text;
          return delta || null;
        } catch {
          return null;
        }
      }
      case 'deepseek': {
        // DeepSeek SSE: choices[0].delta.content 为增量
        const delta = parsed.choices?.[0]?.delta;
        if (delta && typeof delta.content === 'string') {
          return delta.content;
        }
        return null;
      }
      case 'hailuo':
      case 'step':
      case 'spark':
      case 'metaso':
      case 'yuanbao': {
        // 通用 Web Provider: 尝试从 content / text / choices.delta.content 提取
        // 优先检查 OpenAI 格式 (choices.delta.content)
        const oaiDelta = parsed.choices?.[0]?.delta?.content;
        if (typeof oaiDelta === 'string') return oaiDelta;
        // 尝试 content 字段 (累积全文)
        if (typeof parsed.content === 'string') {
          const delta = parsed.content.slice(prevContent.length);
          prevContent = parsed.content;
          return delta || null;
        }
        // 尝试 text 字段 (增量)
        if (typeof parsed.text === 'string') return parsed.text;
        // 尝试 answer 字段 (秘塔等搜索型)
        if (typeof parsed.answer === 'string') {
          const delta = parsed.answer.slice(prevContent.length);
          prevContent = parsed.answer;
          return delta || null;
        }
        return null;
      }
      default:
        return null;
    }
  }

  /** 判断该行是否为流结束标志 */
  function isDone(parsed) {
    if (providerName === 'kimi' && parsed.event === 'all_done') return true;
    if (providerName === 'doubao' && parsed.event_type === 2003) return true;
    // DeepSeek: finish_reason=stop
    if (providerName === 'deepseek' && parsed.choices?.[0]?.finish_reason === 'stop') return true;
    return false;
  }

  return new TransformStream({
    transform(chunk, controller) {
      if (finished) return;
      sseBuffer += decoder.decode(chunk, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '').trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trimStart();
        if (payload === '[DONE]') {
          finished = true;
          // 发送 finish_reason=stop 然后 [DONE]
          controller.enqueue(encodeChunk({}, 'stop'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          return;
        }
        if (!payload) continue;

        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }

        // 先发一个 role=assistant 的首帧（OpenAI 规范）
        if (!sentFirstRole) {
          sentFirstRole = true;
          controller.enqueue(encodeChunk({ role: 'assistant', content: '' }));
        }

        // 检测流结束
        if (isDone(parsed)) {
          finished = true;
          controller.enqueue(encodeChunk({}, 'stop'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          return;
        }

        const delta = extractDelta(parsed);
        if (delta) {
          controller.enqueue(encodeChunk({ content: delta }));
        }
      }
    },
    flush(controller) {
      // 处理 buffer 中残余内容
      if (sseBuffer.trim()) {
        const line = sseBuffer.trim();
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trimStart();
          if (payload && payload !== '[DONE]') {
            try {
              const parsed = JSON.parse(payload);
              const delta = extractDelta(parsed);
              if (delta) {
                controller.enqueue(encodeChunk({ content: delta }));
              }
            } catch {
              // ignore
            }
          }
        }
      }
      if (!finished) {
        controller.enqueue(encodeChunk({}, 'stop'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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
      try {
        const parsed = JSON.parse(payload);
        fullContent = extractFullContent(parsed, providerName, fullContent);
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

/** 从单条 SSE 数据中提取当前累积的完整文本 */
function extractFullContent(parsed, providerName, prev) {
  switch (providerName) {
    case 'qwen':
      return typeof parsed.content === 'string' ? parsed.content : prev;
    case 'kimi':
      // 增量拼接
      if (parsed.event === 'cmpl' && typeof parsed.text === 'string') {
        return prev + parsed.text;
      }
      return prev;
    case 'zhipu': {
      const parts = parsed.parts;
      if (Array.isArray(parts) && parts.length && typeof parts[0].content === 'string') {
        return parts[0].content;
      }
      return prev;
    }
    case 'doubao': {
      if (typeof parsed.event_data !== 'string') return prev;
      try {
        const ed = JSON.parse(parsed.event_data);
        const text = ed?.message?.content?.text ?? ed?.content?.text ?? ed?.text;
        return typeof text === 'string' ? text : prev;
      } catch {
        return prev;
      }
    }
    case 'deepseek': {
      const delta = parsed.choices?.[0]?.delta?.content;
      return typeof delta === 'string' ? prev + delta : prev;
    }
    case 'hailuo':
    case 'step':
    case 'spark':
    case 'metaso':
    case 'yuanbao': {
      // 尝试 OpenAI 格式
      const oaiDelta = parsed.choices?.[0]?.delta?.content;
      if (typeof oaiDelta === 'string') return prev + oaiDelta;
      // 累积全文
      if (typeof parsed.content === 'string') return parsed.content;
      // 增量
      if (typeof parsed.text === 'string') return prev + parsed.text;
      // 搜索型
      if (typeof parsed.answer === 'string') return parsed.answer;
      return prev;
    }
    default: {
      // 兜底：尝试标准 OpenAI SSE 格式 (choices[0].delta.content)
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') return prev + delta;
      if (typeof parsed.content === 'string') return parsed.content;
      if (typeof parsed.text === 'string') return prev + parsed.text;
      return prev;
    }
  }
}
