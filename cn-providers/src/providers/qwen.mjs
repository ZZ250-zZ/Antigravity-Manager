/**
 * 通义千问 Web（qianwen.biz）Provider：Cookie `tongyi_sso_ticket` + SSE。
 * 响应里 incremental 常为 false，每条 data 多为全文，取最后一次有效 content 即可拼完整回复。
 */
import { randomUUID } from 'node:crypto';
import { httpRequest } from '../http-client.mjs';
import { ConversationTracker } from '../utils/conversation-tracker.mjs';
import { createIdExtractingPassthrough } from '../utils/stream-id-extractor.mjs';
import { registerSSEProcessor } from '../converters/sse-registry.mjs';

const BIZ_BASE = 'https://qianwen.biz.aliyun.com';

/** OpenAI 模型 id → 千问 API model 字段 */
const MODEL_MAP = {
  'qwen-max': 'qwen-max-latest',
  'qwen-plus': 'qwen-plus-latest',
  'qwen-turbo': 'qwen-turbo-latest',
  'qwen-long': 'qwen-long-latest',
};

/**
 * @param {string | undefined} model
 * @returns {string}
 */
function mapModel(model) {
  if (!model?.trim()) return 'qwen-plus-latest';
  const m = model.trim();
  if (m.endsWith('-latest')) return m;
  return MODEL_MAP[m] ?? m;
}

/**
 * OpenAI messages → 千问 contents（仅文本；system 合并为带标记的 user 段）
 * @param {Array<{ role: string; content?: unknown }>} messages
 */
function messagesToContents(messages) {
  /** @type {Array<{ role: string; contentType: string; content: string }>} */
  const contents = [];
  for (const msg of messages) {
    const text = normalizeMessageContent(msg.content);
    if (msg.role === 'system') {
      contents.push({
        role: 'user',
        contentType: 'text',
        content: `[System]\n${text}`,
      });
      continue;
    }
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    contents.push({ role, contentType: 'text', content: text });
  }
  return contents;
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function normalizeMessageContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object' && 'text' in p && typeof p.text === 'string') return p.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content ?? '');
}

/**
 * 与验证脚本一致的辅助 Cookie，提高与站点行为一致性
 * @param {string} ticket
 * @param {string} cookieName
 */
function buildCookieHeader(ticket, cookieName = 'tongyi_sso_ticket') {
  return [
    `${cookieName}=${ticket}`,
    'aliyun_choice=intl',
    '_samesite_flag_=true',
    `t=${randomUUID().replace(/-/g, '')}`,
  ].join('; ');
}

/**
 * 从 SSE 字节流中解析出首个 sessionId（用于返回 conversationId）
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {Promise<string>}
 */
async function readSessionIdFromSseStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sessionId = '';
  try {
    while (!sessionId) {
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
          if (obj.sessionId && typeof obj.sessionId === 'string') {
            sessionId = obj.sessionId;
            break;
          }
        } catch {
          // ignore
        }
      }
    }
  } finally {
    // wreq-js 的 tee() 分支不兼容 cancel()，用 releaseLock 替代
    reader.releaseLock();
  }
  return sessionId;
}

export class QwenProvider {
  /**
   * @param {string} token tongyi_sso_ticket
   */
  constructor(token) {
    /** @private */
    this._token = token;
  }

  get name() {
    return 'qwen';
  }

  /**
   * @param {string} sessionId
   */
  async deleteConversation(sessionId) {
    const ticket = this._token;
    const url = `${BIZ_BASE}/dialog/session?sessionId=${encodeURIComponent(sessionId)}`;
    const res = await httpRequest(url, {
      method: 'DELETE',
      headers: {
        Accept: 'application/json, text/plain, */*',
        Cookie: buildCookieHeader(ticket),
        Origin: 'https://chat2.qianwen.com',
        Referer: 'https://chat2.qianwen.com/',
        'X-Platform': 'pc_tongyi',
        'X-Xsrf-Token': randomUUID(),
      },
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Qwen deleteConversation failed: ${res.status} ${errText.slice(0, 200)}`);
    }
  }

  /**
   * @param {Array<{ role: string; content?: unknown }>} messages OpenAI 格式
   * @param {{ token?: string; model?: string; stream?: boolean; tracker?: ConversationTracker }} [options] stream 预留，当前始终返回原始 SSE body
   * @returns {Promise<{ stream: ReadableStream<Uint8Array>; conversationId: string }>}
   */
  async chatCompletion(messages, options = {}) {
    const ticket = options.token ?? this._token;
    const model = mapModel(options.model);
    const contents = messagesToContents(messages);

    const requestId = randomUUID().replace(/-/g, '');
    // 新会话传空串由服务端分配 sessionId（与 verify 脚本一致）
    const sessionId = '';

    const body = {
      action: 'next',
      mode: 'chat',
      model,
      requestId,
      sessionId,
      sessionType: 'text_chat',
      userAction: 'chat',
      parentMsgId: '',
      params: { fileUploadBatchId: randomUUID() },
      contents,
    };

    const res = await httpRequest(`${BIZ_BASE}/dialog/conversation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Cookie: buildCookieHeader(ticket),
        Origin: 'https://chat2.qianwen.com',
        Referer: 'https://chat2.qianwen.com/',
        'X-Platform': 'pc_tongyi',
        'X-Xsrf-Token': randomUUID(),
      },
      body: JSON.stringify(body),
      timeoutMs: 0,
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Qwen chatCompletion failed: ${res.status} ${errText.slice(0, 300)}`);
    }

    // 用 passthrough 提取 sessionId，避免 tee()（wreq-js tee 在 Windows 上有兼容问题）
    const { stream, idPromise } = createIdExtractingPassthrough(
      res.body,
      (obj) => (obj.sessionId && typeof obj.sessionId === 'string') ? obj.sessionId : null,
    );

    const tracker = options.tracker;
    idPromise.then((conversationId) => {
      if (tracker && conversationId) {
        tracker.record(conversationId, this.name, () => this.deleteConversation(conversationId));
      }
    });

    return { stream, conversationId: '', _idPromise: idPromise };
  }
}

// Qwen SSE：content 为全文（非增量），需自行算 delta
registerSSEProcessor('qwen', {
  isRawPayload: false,

  extractDelta(parsed, state) {
    // 检测服务端错误（如 NOT_LOGIN 表示会话失效）
    if (parsed.errorCode && typeof parsed.errorCode === 'string' && parsed.errorCode !== '') {
      if (!state._errorReported) {
        state._errorReported = true;
        return `[Qwen Error: ${parsed.errorCode}] 请重新登录并更新 token`;
      }
      return null;
    }
    if (parsed.contentType === 'plugin') return null;
    let full = null;
    if (Array.isArray(parsed.contents) && parsed.contents.length > 0) {
      const textContent = parsed.contents.find(c => c.contentType !== 'plugin');
      if (textContent) full = typeof textContent.content === 'string' ? textContent.content : null;
    } else if (typeof parsed.content === 'string') {
      full = parsed.content;
    }
    if (full === null) return null;
    const delta = full.slice(state.prevContent.length);
    state.prevContent = full;
    return delta || null;
  },

  extractFullContent(parsed, prev) {
    if (parsed.errorCode && typeof parsed.errorCode === 'string' && parsed.errorCode !== '') {
      return `[Qwen Error: ${parsed.errorCode}] 请重新登录并更新 token`;
    }
    if (parsed.contentType === 'plugin') return prev;
    if (Array.isArray(parsed.contents) && parsed.contents.length > 0) {
      const textContent = parsed.contents.find(c => c.contentType !== 'plugin');
      return textContent && typeof textContent.content === 'string' ? textContent.content : prev;
    }
    return typeof parsed.content === 'string' ? parsed.content : prev;
  },

  isDone(_parsed) {
    return false;
  },
});
