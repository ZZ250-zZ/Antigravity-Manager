/**
 * SSE 处理函数注册表：每个 provider 注册自己的 SSE 解析逻辑。
 *
 * 每个 provider 需要实现以下接口：
 *   extractDelta(parsed, state)        → string | null  从解析后的 SSE 数据提取增量文本
 *   extractFullContent(parsed, prev)   → string          从 SSE 数据累积完整文本（非流式模式）
 *   isDone(parsed)                     → boolean         判断流是否结束
 *   isRawPayload                       → boolean         是否需要在 JSON 解析前特殊处理（如 base64）
 *   processRawPayload(payload, state)  → { content: string } | null  处理非 JSON 格式的 payload
 *
 * state 对象由 native-to-openai.mjs 维护，包含 prevContent 等状态。
 */

const registry = new Map();

export function registerSSEProcessor(providerName, processor) {
  registry.set(providerName, processor);
}

/**
 * 获取指定 provider 的 SSE 处理器。
 * 未注册的 provider 返回兜底处理器（尝试 OpenAI 标准格式）。
 */
export function getSSEProcessor(providerName) {
  return registry.get(providerName) ?? fallbackProcessor;
}

// 兜底处理器：尝试 OpenAI 标准 SSE 格式 (choices[0].delta.content)
const fallbackProcessor = {
  isRawPayload: false,
  extractDelta(parsed, _state) {
    const delta = parsed.choices?.[0]?.delta?.content;
    if (typeof delta === 'string') return delta;
    if (typeof parsed.content === 'string') return parsed.content;
    if (typeof parsed.text === 'string') return parsed.text;
    return null;
  },
  extractFullContent(parsed, prev) {
    const delta = parsed.choices?.[0]?.delta?.content;
    if (typeof delta === 'string') return prev + delta;
    if (typeof parsed.content === 'string') return parsed.content;
    if (typeof parsed.text === 'string') return prev + parsed.text;
    return prev;
  },
  isDone: () => false,
};
