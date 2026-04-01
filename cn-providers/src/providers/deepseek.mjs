/**
 * DeepSeek Web API Provider: chat.deepseek.com 逆向。
 *
 * 认证: userToken (从浏览器 localStorage 获取)
 * 流程: 创建会话 → PoW 挑战 → 发送消息 → SSE 流式响应
 *
 * SSE 响应格式 (每行 data:):
 *   { choices: [{ delta: { content: "...", role: "assistant" }, finish_reason: null|"stop" }] }
 *
 * 注意: DeepSeek 有 Cloudflare 保护，如遇 403 需要提供 cf_clearance cookie。
 */

import { randomUUID } from 'node:crypto';
import { httpRequest } from '../http-client.mjs';
import { solveChallenge } from '../utils/deepseek-pow.mjs';
import { ConversationTracker } from '../utils/conversation-tracker.mjs';
import { registerSSEProcessor } from '../converters/sse-registry.mjs';

const BASE_URL = 'https://chat.deepseek.com/api/v0';

/** 模型映射 */
const MODEL_MAP = {
  deepseek: 'deepseek_chat',
  'deepseek-chat': 'deepseek_chat',
  'deepseek-v3': 'deepseek_chat',
  'deepseek-r1': 'deepseek_chat',
  'deepseek-reasoner': 'deepseek_chat',
  'deepseek-code': 'deepseek_code',
  'deepseek-coder': 'deepseek_code',
};

function mapModel(model) {
  const m = (model ?? '').trim().toLowerCase();
  return MODEL_MAP[m] ?? 'deepseek_chat';
}

/** 判断是否启用思考模式 (R1 reasoner) */
function isThinkingModel(model) {
  const m = (model ?? '').trim().toLowerCase();
  return m.includes('r1') || m.includes('reasoner');
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

/** 把 OpenAI messages 合并为单个 prompt（DeepSeek Web API 接受 prompt 字符串） */
function messagesToPrompt(messages) {
  const parts = [];
  for (const msg of messages) {
    const text = normalizeMessageContent(msg.content);
    if (msg.role === 'system') {
      parts.push(`[System]\n${text}`);
    } else if (msg.role === 'assistant') {
      parts.push(`[Assistant]\n${text}`);
    } else {
      parts.push(text);
    }
  }
  return parts.join('\n\n');
}

export class DeepSeekProvider {
  /**
   * @param {string} token userToken (从浏览器 localStorage 获取)
   */
  constructor(token) {
    /** @private */
    this._token = token;
  }

  get name() {
    return 'deepseek';
  }

  /** @private 构建通用请求头 */
  _headers() {
    return {
      Authorization: `Bearer ${this._token}`,
      'Content-Type': 'application/json',
      Accept: '*/*',
      Origin: 'https://chat.deepseek.com',
      Referer: 'https://chat.deepseek.com/',
    };
  }

  /**
   * 创建聊天会话
   * @returns {Promise<string>} chat_session_id
   */
  async createSession() {
    const res = await httpRequest(`${BASE_URL}/chat_session/create`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`DeepSeek createSession failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const sessionId = data?.data?.biz_data?.id ?? data?.data?.id;
    if (!sessionId) {
      throw new Error('DeepSeek createSession: missing session id');
    }
    return sessionId;
  }

  /**
   * 获取并求解 PoW 挑战
   * @returns {Promise<string>} base64 编码的 PoW 解答
   */
  async solvePoW() {
    const res = await httpRequest(`${BASE_URL}/chat/create_pow_challenge`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({
        target_path: '/api/v0/chat/completion',
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`DeepSeek PoW challenge failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const rawChallenge = data?.data?.biz_data ?? data?.data;
    // biz_data 可能是 { challenge: { algorithm, challenge, salt, ... } } 嵌套结构
    const challenge = rawChallenge?.challenge && typeof rawChallenge.challenge === 'object'
      ? rawChallenge.challenge
      : rawChallenge;
    if (!challenge || !challenge.challenge) {
      throw new Error('DeepSeek PoW: invalid challenge response');
    }
    // solveChallenge 是异步的（加载 WASM）
    return await solveChallenge(challenge);
  }

  /**
   * @param {string} sessionId
   */
  async deleteConversation(sessionId) {
    // DeepSeek 删除会话 API（使用 clear_context 替代 DELETE，兼容新 API）
    const res = await httpRequest(`${BASE_URL}/chat_session/delete`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ chat_session_id: sessionId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`DeepSeek deleteConversation failed: ${res.status} ${text.slice(0, 200)}`);
    }
  }

  /**
   * @param {Array<{ role: string; content?: unknown }>} messages
   * @param {{ token?: string; model?: string; stream?: boolean; tracker?: ConversationTracker }} [options]
   * @returns {Promise<{ stream: ReadableStream<Uint8Array>; conversationId: string }>}
   */
  async chatCompletion(messages, options = {}) {
    if (options.token) this._token = options.token;
    const thinkingEnabled = isThinkingModel(options.model);
    const prompt = messagesToPrompt(messages);

    // 1. 创建会话
    const sessionId = await this.createSession();

    // 2. 求解 PoW
    let powSolution;
    try {
      powSolution = await this.solvePoW();
    } catch (e) {
      // PoW 可能不总是必需的，尝试无 PoW 请求
      console.warn(`[DeepSeek] PoW 求解失败，尝试无 PoW 发送: ${e.message}`);
      powSolution = null;
    }

    // 3. 发送聊天请求
    const body = {
      chat_session_id: sessionId,
      parent_message_id: null,
      prompt,
      ref_file_ids: [],
      thinking_enabled: thinkingEnabled,
      search_enabled: false,
    };

    const headers = {
      ...this._headers(),
      Accept: 'text/event-stream',
    };
    if (powSolution) {
      headers['x-ds-pow-response'] = powSolution;
    }

    const res = await httpRequest(`${BASE_URL}/chat/completion`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      timeoutMs: 0,
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(`DeepSeek chatCompletion failed: ${res.status} ${errText.slice(0, 300)}`);
    }

    const tracker = options.tracker;
    if (tracker && sessionId) {
      tracker.record(sessionId, this.name, () => this.deleteConversation(sessionId));
    }

    return { stream: res.body, conversationId: sessionId };
  }
}

// DeepSeek Web SSE：增量文本在 v 字段，路径标识事件类型
registerSSEProcessor('deepseek', {
  isRawPayload: false,

  extractDelta(parsed, _state) {
    if (parsed.p && parsed.p !== 'response/content') return null;
    if (typeof parsed.v === 'string') return parsed.v;
    return null;
  },

  extractFullContent(parsed, prev) {
    if (parsed.p && parsed.p !== 'response/content') return prev;
    return typeof parsed.v === 'string' ? prev + parsed.v : prev;
  },

  isDone(parsed) {
    return parsed.p === 'response/status' && parsed.v === 'FINISHED';
  },
});
