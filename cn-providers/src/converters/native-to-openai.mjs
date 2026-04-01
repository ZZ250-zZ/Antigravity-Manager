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
    // 临时调试：输出原始解析数据（修复后移除）
    if (['doubao', 'deepseek', 'metaso', 'step', 'spark', 'yuanbao', 'momi'].includes(providerName)) {
      console.log(`[DEBUG extractDelta][${providerName}] keys=${Object.keys(parsed).join(',')}, snippet=${JSON.stringify(parsed).slice(0, 250)}`);
    }
    switch (providerName) {
      case 'qwen': {
        // 跳过 plugin 类型事件（搜索结果等元数据，不是正文内容）
        if (parsed.contentType === 'plugin') return null;
        // Qwen 新版 API：文本在 contents[0].content（数组），旧版在 content（字符串）
        let full = null;
        if (Array.isArray(parsed.contents) && parsed.contents.length > 0) {
          // 只提取 text 类型的 content，跳过 plugin 类型
          const textContent = parsed.contents.find(c => c.contentType !== 'plugin');
          if (textContent) {
            full = typeof textContent.content === 'string' ? textContent.content : null;
          }
        } else if (typeof parsed.content === 'string') {
          full = parsed.content;
        }
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
        // parts[0].content 是数组 [{type:"text", text:"全文", tool_calls:{}}]
        const parts = parsed.parts;
        if (!Array.isArray(parts) || !parts.length) return null;
        const c = parts[0].content;
        // content 可能是字符串（旧版）或数组（新版）
        const full = typeof c === 'string' ? c
          : (Array.isArray(c) && c[0]?.text) ? c[0].text
          : null;
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
        // DeepSeek Web SSE 格式：
        //   {"p":"response/content","o":"APPEND","v":"text"} — 带路径的增量
        //   {"v":"text"} — 简化增量（路径省略，隐含 response/content APPEND）
        //   {"p":"response/status","v":"FINISHED"} — 结束标志，不含文本
        //   {"p":"response/accumulated_token_usage",...} — token 统计，跳过
        if (parsed.p && parsed.p !== 'response/content') return null;
        if (typeof parsed.v === 'string') return parsed.v;
        return null;
      }
      case 'metaso': {
        // Metaso 新版 SSE：type 字段标识事件类型
        // 跳过元数据事件（conversation_init / user_message_init / response_message_init）
        if (parsed.type && ['conversation_init', 'user_message_init', 'response_message_init', 'error'].includes(parsed.type)) {
          // 如果是 error 事件，打印日志但不返回内容
          if (parsed.type === 'error') {
            console.log(`[metaso] SSE error: ${parsed.msg ?? JSON.stringify(parsed)}`);
          }
          return null;
        }
        // 尝试从 data.text / data.content 提取内容
        if (parsed.data && typeof parsed.data.text === 'string') return parsed.data.text;
        if (parsed.data && typeof parsed.data.content === 'string') {
          const delta = parsed.data.content.slice(prevContent.length);
          prevContent = parsed.data.content;
          return delta || null;
        }
        // 兜底：直接检查 content / text / answer 字段
        if (typeof parsed.content === 'string') {
          const delta = parsed.content.slice(prevContent.length);
          prevContent = parsed.content;
          return delta || null;
        }
        if (typeof parsed.text === 'string') return parsed.text;
        if (typeof parsed.answer === 'string') {
          const delta = parsed.answer.slice(prevContent.length);
          prevContent = parsed.answer;
          return delta || null;
        }
        return null;
      }
      case 'momi': {
        // MOMI SSE: event:message → data:{"type":"text","content":"增量文本"}
        // 跳过 dialogId 事件（content 为纯数字 ID）和 usage 事件
        if (parsed.promptTokens !== undefined) return null;
        if (parsed.content && !parsed.type && /^\d+$/.test(String(parsed.content))) return null;
        // message 事件：type=text, content 为增量文本
        if (parsed.type === 'text' && typeof parsed.content === 'string') {
          // 过滤 <think>...</think> 思考标签内容
          let text = parsed.content;
          // 处理 thinking 标签：移除 <think> 到 </think> 之间的内容
          text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
          // 如果当前 chunk 只有 <think> 开头（后续 chunk 会有 </think>），跳过
          if (text.includes('<think>')) {
            // 记录进入 thinking 模式
            prevContent = '<THINKING>';
            return null;
          }
          if (prevContent === '<THINKING>') {
            // 在 thinking 模式中，等待 </think>
            if (text.includes('</think>')) {
              prevContent = '';
              text = text.split('</think>').pop() ?? '';
              return text || null;
            }
            return null;
          }
          return text || null;
        }
        return null;
      }
      case 'spark': {
        // Spark SSE 数据是 base64 编码的文本（不是 JSON），在 transform 主循环中特殊处理
        // 此分支仅作为兜底：如果意外进入了 JSON 解析路径
        if (typeof parsed.content === 'string') return parsed.content;
        if (typeof parsed.text === 'string') return parsed.text;
        return null;
      }
      case 'yuanbao': {
        // 元宝 SSE: data: {"type":"text","msg":"增量文本"}
        if (parsed.type === 'text' && typeof parsed.msg === 'string') return parsed.msg;
        // 兜底：其他格式
        if (typeof parsed.content === 'string') return parsed.content;
        if (typeof parsed.text === 'string') return parsed.text;
        return null;
      }
      case 'hailuo':
      case 'step': {
        // 通用 Web Provider: 尝试从 content / text / choices.delta.content 提取
        const oaiDelta = parsed.choices?.[0]?.delta?.content;
        if (typeof oaiDelta === 'string') return oaiDelta;
        if (typeof parsed.content === 'string') {
          const delta = parsed.content.slice(prevContent.length);
          prevContent = parsed.content;
          return delta || null;
        }
        if (typeof parsed.text === 'string') return parsed.text;
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
    // DeepSeek Web: {"p":"response/status","v":"FINISHED"}
    if (providerName === 'deepseek' && parsed.p === 'response/status' && parsed.v === 'FINISHED') return true;
    return false;
  }

  return new TransformStream({
    transform(chunk, controller) {
      if (finished) return;
      const rawText = decoder.decode(chunk, { stream: true });
      // 临时调试：查看原始 chunk 数据（修复后移除）
      if (['doubao', 'deepseek', 'metaso', 'step', 'spark', 'yuanbao', 'momi'].includes(providerName)) {
        console.log(`[DEBUG chunk][${providerName}] len=${rawText.length}, data=${rawText.slice(0, 300)}`);
      }
      sseBuffer += rawText;
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '').trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trimStart();
        if (payload === '[DONE]') {
          finished = true;
          controller.enqueue(encodeChunk({}, 'stop'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          return;
        }
        if (!payload) continue;

        // Spark 特殊处理：SSE data 是 base64 编码的文本（不是 JSON）
        if (providerName === 'spark') {
          // <end> 为流结束标记
          if (payload === '<end>') {
            finished = true;
            controller.enqueue(encodeChunk({}, 'stop'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            return;
          }
          // 跳过 session ID 行（cht...@...<sid>）和插件推荐
          if (payload.includes('<sid>') || payload.startsWith('```')) continue;
          // base64 解码为文本
          try {
            const decoded = Buffer.from(payload, 'base64').toString('utf8');
            // 跳过深度思考事件（<deep_x1>JSON），只保留正文文本
            if (decoded && !decoded.startsWith('<deep_x1>')) {
              if (!sentFirstRole) {
                sentFirstRole = true;
                controller.enqueue(encodeChunk({ role: 'assistant', content: '' }));
              }
              controller.enqueue(encodeChunk({ content: decoded }));
            }
          } catch {
            // 非法 base64，跳过
          }
          continue;
        }

        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }

        if (!sentFirstRole) {
          sentFirstRole = true;
          controller.enqueue(encodeChunk({ role: 'assistant', content: '' }));
        }

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
            // Spark: base64 解码残余数据，跳过深度思考
            if (providerName === 'spark') {
              if (payload !== '<end>' && !payload.includes('<sid>') && !payload.startsWith('```')) {
                try {
                  const decoded = Buffer.from(payload, 'base64').toString('utf8');
                  if (decoded && !decoded.startsWith('<deep_x1>')) controller.enqueue(encodeChunk({ content: decoded }));
                } catch { /* ignore */ }
              }
            } else {
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

      // Spark: base64 解码拼接文本，跳过深度思考事件
      if (providerName === 'spark') {
        if (payload === '<end>') break;
        if (payload.includes('<sid>') || payload.startsWith('```')) continue;
        try {
          const decoded = Buffer.from(payload, 'base64').toString('utf8');
          if (decoded && !decoded.startsWith('<deep_x1>')) {
            fullContent += decoded;
          }
        } catch { /* ignore */ }
        continue;
      }

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
    case 'qwen': {
      // 跳过 plugin 类型事件
      if (parsed.contentType === 'plugin') return prev;
      // 新版：contents[0].content（取 text 类型）；旧版：content
      if (Array.isArray(parsed.contents) && parsed.contents.length > 0) {
        const textContent = parsed.contents.find(c => c.contentType !== 'plugin');
        return textContent && typeof textContent.content === 'string' ? textContent.content : prev;
      }
      return typeof parsed.content === 'string' ? parsed.content : prev;
    }
    case 'kimi':
      // 增量拼接
      if (parsed.event === 'cmpl' && typeof parsed.text === 'string') {
        return prev + parsed.text;
      }
      return prev;
    case 'zhipu': {
      const parts = parsed.parts;
      if (!Array.isArray(parts) || !parts.length) return prev;
      const c = parts[0].content;
      const text = typeof c === 'string' ? c
        : (Array.isArray(c) && c[0]?.text) ? c[0].text
        : null;
      return text ?? prev;
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
      // Web SSE：v 字段是增量文本，拼接到 prev
      if (parsed.p && parsed.p !== 'response/content') return prev;
      return typeof parsed.v === 'string' ? prev + parsed.v : prev;
    }
    case 'spark': {
      // Spark base64 SSE 已在 collectNonStreamResponse 中直接解码拼接
      // 此处作为兜底
      if (typeof parsed.content === 'string') return parsed.content;
      if (typeof parsed.text === 'string') return prev + parsed.text;
      return prev;
    }
    case 'hailuo':
    case 'step':
    case 'metaso': {
      // 跳过元数据和错误事件
      if (parsed.type && ['conversation_init', 'user_message_init', 'response_message_init', 'error'].includes(parsed.type)) return prev;
      // 从 data 字段提取
      if (parsed.data && typeof parsed.data.text === 'string') return prev + parsed.data.text;
      if (parsed.data && typeof parsed.data.content === 'string') return parsed.data.content;
      // 兜底
      if (typeof parsed.content === 'string') return parsed.content;
      if (typeof parsed.text === 'string') return prev + parsed.text;
      if (typeof parsed.answer === 'string') return parsed.answer;
      return prev;
    }
    case 'momi': {
      // MOMI: type=text 的 message 事件，增量拼接
      if (parsed.type === 'text' && typeof parsed.content === 'string') {
        let text = parsed.content;
        text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
        if (text.includes('<think>') || text.includes('</think>')) return prev;
        return prev + text;
      }
      return prev;
    }
    case 'yuanbao': {
      // 元宝 SSE: data: {"type":"text","msg":"增量文本"}
      if (parsed.type === 'text' && typeof parsed.msg === 'string') return prev + parsed.msg;
      if (typeof parsed.content === 'string') return parsed.content;
      if (typeof parsed.text === 'string') return prev + parsed.text;
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
