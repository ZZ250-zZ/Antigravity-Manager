/**
 * 海螺AI (MiniMax) Web API Provider: hailuoai.com
 *
 * 认证: _token (从浏览器 LocalStorage 获取)
 * API 基址: https://hailuoai.com (内部 API 端点)
 *
 * 海螺AI 使用标准的 Bearer Token 认证 + SSE 流式响应。
 * Token 从 hailuoai.com 的 LocalStorage `_token` 字段获取。
 */

import { randomUUID } from 'node:crypto';
import { httpRequest } from '../http-client.mjs';
import { ConversationTracker } from '../utils/conversation-tracker.mjs';
import { createIdExtractingPassthrough } from '../utils/stream-id-extractor.mjs';
import { registerSSEProcessor } from '../converters/sse-registry.mjs';

const BASE_URL = 'https://hailuoai.com';

/** 模型映射：对外模型名 → 内部标识 */
const MODEL_MAP = {
  hailuo: 'hailuo',
  minimax: 'hailuo',
  'minimax-text': 'hailuo',
};

function mapModel(model) {
  const m = (model ?? '').trim().toLowerCase();
  return MODEL_MAP[m] ?? 'hailuo';
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p?.text ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  return String(content ?? '');
}

function messagesToText(messages) {
  const parts = [];
  for (const msg of messages) {
    const text = normalizeMessageContent(msg.content);
    if (msg.role === 'system') parts.push(`[System]\n${text}`);
    else if (msg.role === 'assistant') parts.push(`[Assistant]\n${text}`);
    else parts.push(text);
  }
  return parts.join('\n\n');
}

/** 从 SSE 流中提取 conversation_id */
async function readConvIdFromStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let convId = '';
  try {
    while (!convId) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, '').trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trimStart();
        if (payload === '[DONE]' || !payload) continue;
        try {
          const obj = JSON.parse(payload);
          // 尝试从各种字段中提取 conversation_id
          const cid = obj.chatID ?? obj.chat_id ?? obj.conversation_id ?? obj.id;
          if (cid && typeof cid === 'string') {
            convId = cid;
            break;
          }
        } catch { /* ignore */ }
      }
    }
  } finally {
    // wreq-js 的 tee() 分支不兼容 cancel()，用 releaseLock 替代
    reader.releaseLock();
  }
  return convId;
}

export class HailuoProvider {
  /**
   * @param {string} token _token (从 hailuoai.com LocalStorage 获取)
   */
  constructor(token) {
    /** @private */
    this._token = token;
  }

  get name() {
    return 'hailuo';
  }

  /** @private */
  _headers(extra = {}) {
    return {
      Authorization: `Bearer ${this._token}`,
      'Content-Type': 'application/json',
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      ...extra,
    };
  }

  async deleteConversation(convId) {
    const res = await httpRequest(`${BASE_URL}/api/chat/${encodeURIComponent(convId)}`, {
      method: 'DELETE',
      headers: this._headers(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Hailuo deleteConversation failed: ${res.status} ${text.slice(0, 200)}`);
    }
  }

  /**
   * @param {Array<{ role: string; content?: unknown }>} messages
   * @param {{ token?: string; model?: string; stream?: boolean; tracker?: ConversationTracker }} [options]
   * @returns {Promise<{ stream: ReadableStream<Uint8Array>; conversationId: string }>}
   */
  async chatCompletion(messages, options = {}) {
    if (options.token) this._token = options.token;

    // 海螺AI 的 Web 端 API：发送消息到聊天页面
    const userText = messagesToText(messages);
    const body = {
      chatID: '',
      prompt: userText,
      botID: '',
      source: 'chatPage',
      attachments: [],
    };

    const res = await httpRequest(`${BASE_URL}/api/chat/completion`, {
      method: 'POST',
      headers: this._headers({ Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
      timeoutMs: 0,
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Hailuo chatCompletion failed: ${res.status} ${errText.slice(0, 300)}`);
    }

    // 用 passthrough 提取 conversation_id，避免 tee()
    const { stream, idPromise } = createIdExtractingPassthrough(res.body, (obj) => {
      const cid = obj.chatID ?? obj.chat_id ?? obj.conversation_id ?? obj.id;
      return (cid && typeof cid === 'string') ? cid : null;
    });

    const tracker = options.tracker;
    idPromise.then((conversationId) => {
      if (tracker && conversationId) {
        tracker.record(conversationId, this.name, () => this.deleteConversation(conversationId));
      }
    });

    return { stream, conversationId: '', _idPromise: idPromise };
  }
}

// Hailuo/Step 通用 Web SSE：尝试 choices.delta.content / content / text / answer
function _webGenericExtractDelta(parsed, state) {
  const oaiDelta = parsed.choices?.[0]?.delta?.content;
  if (typeof oaiDelta === 'string') return oaiDelta;
  if (typeof parsed.content === 'string') {
    const delta = parsed.content.slice(state.prevContent.length);
    state.prevContent = parsed.content;
    return delta || null;
  }
  if (typeof parsed.text === 'string') return parsed.text;
  if (typeof parsed.answer === 'string') {
    const delta = parsed.answer.slice(state.prevContent.length);
    state.prevContent = parsed.answer;
    return delta || null;
  }
  return null;
}

function _webGenericExtractFull(parsed, prev) {
  const delta = parsed.choices?.[0]?.delta?.content;
  if (typeof delta === 'string') return prev + delta;
  if (typeof parsed.content === 'string') return parsed.content;
  if (typeof parsed.text === 'string') return prev + parsed.text;
  if (typeof parsed.answer === 'string') return parsed.answer;
  return prev;
}

registerSSEProcessor('hailuo', {
  isRawPayload: false,
  extractDelta: _webGenericExtractDelta,
  extractFullContent: _webGenericExtractFull,
  isDone: () => false,
});
