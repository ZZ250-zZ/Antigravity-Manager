/**
 * 秘塔AI (Metaso) Web API Provider: metaso.cn
 *
 * 认证: uid-sid (从浏览器 Cookies 获取的 uid 和 sid 用 "-" 拼接)
 *
 * 秘塔AI 是搜索增强型 AI，内部 API 返回 SSE 流式响应。
 * 支持 简洁/深入/研究 三种模式。
 */

import { randomUUID } from 'node:crypto';
import { httpRequest } from '../http-client.mjs';
import { ConversationTracker } from '../utils/conversation-tracker.mjs';
import { createIdExtractingPassthrough } from '../utils/stream-id-extractor.mjs';

const BASE_URL = 'https://metaso.cn';

/** 模型映射 */
const MODEL_MAP = {
  metaso: 'concise',
  'metaso-concise': 'concise',
  'metaso-detail': 'detail',
  'metaso-research': 'research',
};

function mapModel(model) {
  const m = (model ?? '').trim().toLowerCase();
  return MODEL_MAP[m] ?? 'concise';
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
  // 秘塔是搜索引擎式 AI，只取最后一条 user 消息
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' || messages[i].role === 'system') {
      return normalizeMessageContent(messages[i].content);
    }
  }
  return '';
}

/** 解析 token: "uid-sid" 格式 */
function parseToken(rawToken) {
  const idx = rawToken.indexOf('-');
  if (idx > 0) {
    return { uid: rawToken.slice(0, idx), sid: rawToken.slice(idx + 1) };
  }
  return { uid: rawToken, sid: '' };
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
          const cid = obj.id ?? obj.conversation_id ?? obj.session_id;
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

export class MetasoProvider {
  /**
   * @param {string} token  "uid-sid" 格式
   */
  constructor(token) {
    /** @private */
    this._token = token;
  }

  get name() {
    return 'metaso';
  }

  /** @private */
  _headers(extra = {}) {
    const { uid, sid } = parseToken(this._token);
    return {
      'Content-Type': 'application/json',
      Cookie: `uid=${uid}; sid=${sid}`,
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      ...extra,
    };
  }

  // 秘塔搜索式 AI 可能不支持删除会话
  async deleteConversation(_convId) {
    // no-op: 秘塔 AI 搜索不一定有显式删除 API
  }

  /**
   * @param {Array<{ role: string; content?: unknown }>} messages
   * @param {{ token?: string; model?: string; stream?: boolean; tracker?: ConversationTracker }} [options]
   * @returns {Promise<{ stream: ReadableStream<Uint8Array>; conversationId: string }>}
   */
  async chatCompletion(messages, options = {}) {
    if (options.token) this._token = options.token;
    const mode = mapModel(options.model);
    const query = messagesToText(messages);

    const body = {
      question: query,
      mode,
    };

    const res = await httpRequest(`${BASE_URL}/api/search`, {
      method: 'POST',
      headers: this._headers({ Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Metaso chatCompletion failed: ${res.status} ${errText.slice(0, 300)}`);
    }

    // 用 passthrough 提取 convId，避免 tee()
    const { stream, idPromise } = createIdExtractingPassthrough(res.body, (obj) => {
      const cid = obj.id ?? obj.conversation_id ?? obj.session_id;
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
