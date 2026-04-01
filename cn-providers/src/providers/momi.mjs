/**
 * 小米 MOMI (aistudio.xiaomimimo.com) Web API Provider
 *
 * 认证: 完整 Cookie 字符串（含 serviceToken, userId, xiaomichatbot_ph 等）
 *
 * SSE 响应事件类型:
 *   event:dialogId  → data:{"content":"<dialogId>"}
 *   event:message   → data:{"type":"text","content":"<增量文本>"}
 *   event:usage     → data:{"promptTokens":..., "completionTokens":...}
 *
 * 模型: mimo-v2-pro (默认), mimo-v2-lite 等
 */

import { randomUUID } from 'node:crypto';
import { httpRequest } from '../http-client.mjs';
import { ConversationTracker } from '../utils/conversation-tracker.mjs';
import { createIdExtractingPassthrough } from '../utils/stream-id-extractor.mjs';

const BASE_URL = 'https://aistudio.xiaomimimo.com';

/** 模型映射 */
const MODEL_MAP = {
  momi: 'mimo-v2-pro',
  'momi-pro': 'mimo-v2-pro',
  'momi-lite': 'mimo-v2-lite',
  'mimo-v2-pro': 'mimo-v2-pro',
  'mimo-v2-lite': 'mimo-v2-lite',
};

function mapModel(model) {
  const m = (model ?? '').trim().toLowerCase();
  return MODEL_MAP[m] ?? 'mimo-v2-pro';
}

/** 生成 32 位 hex ID（MOMI 使用的 ID 格式） */
function hexId() {
  return randomUUID().replace(/-/g, '');
}

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p?.text ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  return String(content ?? '');
}

/** 从 Cookie 字符串中提取 xiaomichatbot_ph 参数值 */
function extractPh(cookieStr) {
  const match = cookieStr.match(/xiaomichatbot_ph=([^;]+)/);
  return match ? match[1].trim().replace(/^"/, '').replace(/"$/, '') : '';
}

export class MomiProvider {
  /**
   * @param {string} token 完整 Cookie 字符串
   */
  constructor(token) {
    /** @private */
    this._token = token;
    /** @private */
    this._ph = extractPh(token);
  }

  get name() {
    return 'momi';
  }

  /** @private */
  _headers(extra = {}) {
    return {
      'Content-Type': 'application/json',
      'Accept-Language': 'system',
      'x-timeZone': 'Asia/Shanghai',
      Cookie: this._token,
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      ...extra,
    };
  }

  /** @private 拼接 ph 查询参数 */
  _url(path) {
    const ph = encodeURIComponent(this._ph);
    return `${BASE_URL}${path}?xiaomichatbot_ph=${ph}`;
  }

  /**
   * 删除会话
   * @param {string} convId conversationId
   */
  async deleteConversation(convId) {
    try {
      await httpRequest(this._url('/open-apis/chat/conversation/delete'), {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ conversationId: convId }),
      });
    } catch { /* 静默忽略 */ }
  }

  /**
   * @param {Array<{ role: string; content?: unknown }>} messages
   * @param {{ token?: string; model?: string; stream?: boolean; tracker?: ConversationTracker }} [options]
   */
  async chatCompletion(messages, options = {}) {
    if (options.token) {
      this._token = options.token;
      this._ph = extractPh(options.token);
    }

    const model = mapModel(options.model);
    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    const query = lastUserMsg ? normalizeContent(lastUserMsg.content) : '';

    const conversationId = hexId();
    const msgId = hexId();

    // 先创建会话
    await httpRequest(this._url('/open-apis/chat/conversation/save'), {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({
        conversationId,
        title: '新对话',
        type: 'chat',
      }),
    });

    // 发送消息
    const body = {
      msgId,
      conversationId,
      query,
      isEditedQuery: false,
      modelConfig: {
        enableThinking: false,
        webSearchStatus: 'disabled',
        model,
      },
      multiMedias: [],
    };

    const res = await httpRequest(this._url('/open-apis/bot/chat'), {
      method: 'POST',
      headers: this._headers({ Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(`MOMI chatCompletion failed: ${res.status} ${errText.slice(0, 300)}`);
    }

    // 从 dialogId 事件中提取 ID（用于后续清理）
    const { stream, idPromise } = createIdExtractingPassthrough(res.body, (obj) => {
      // dialogId 事件的 data 没有 type 字段，只有 content（数字字符串）
      if (obj.content && !obj.type && /^\d+$/.test(obj.content)) {
        return obj.content;
      }
      return null;
    });

    const tracker = options.tracker;
    idPromise.then(() => {
      // 使用 conversationId 进行清理
      if (tracker) {
        tracker.record(conversationId, this.name, () => this.deleteConversation(conversationId));
      }
    });

    return { stream, conversationId, _idPromise: idPromise };
  }
}
