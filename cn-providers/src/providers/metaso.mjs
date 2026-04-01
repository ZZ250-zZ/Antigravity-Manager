/**
 * 秘塔AI (Metaso) Web API Provider: metaso.cn
 *
 * 认证: 完整 Cookie 字符串（从浏览器 CDP 提取）
 *
 * 秘塔AI 是搜索增强型 AI，使用 /api/search/chat 端点返回 SSE 流式响应。
 * SSE 事件 type 分类：conversation_init / user_message_init / response_message_init / text / error
 * 支持 concise(简洁) / detail(深入) / research(研究) 三种模式。
 */

import { randomUUID } from 'node:crypto';
import { httpRequest } from '../http-client.mjs';
import { ConversationTracker } from '../utils/conversation-tracker.mjs';
import { createIdExtractingPassthrough } from '../utils/stream-id-extractor.mjs';

const BASE_URL = 'https://metaso.cn';

/** 模型映射：外部模型名 → Metaso 内部 mode */
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

export class MetasoProvider {
  /**
   * @param {string} token  完整 Cookie 字符串或 "uid-sid" 格式
   */
  constructor(token) {
    /** @private */
    this._token = token;
  }

  get name() {
    return 'metaso';
  }

  /** @private 构造请求头，支持完整 Cookie 或 uid-sid 格式 */
  _headers(extra = {}) {
    let cookieStr = this._token;
    // 兼容旧的 "uid-sid" 格式
    if (!cookieStr.includes('=')) {
      const idx = cookieStr.indexOf('-');
      if (idx > 0) {
        cookieStr = `uid=${cookieStr.slice(0, idx)}; sid=${cookieStr.slice(idx + 1)}`;
      }
    }
    return {
      'Content-Type': 'application/json',
      Cookie: cookieStr,
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      ...extra,
    };
  }

  // 秘塔搜索式 AI 不支持删除会话
  async deleteConversation(_convId) {
    // no-op
  }

  /**
   * @param {Array<{ role: string; content?: unknown }>} messages
   * @param {{ token?: string; model?: string; stream?: boolean; tracker?: ConversationTracker }} [options]
   * @returns {Promise<{ stream: ReadableStream<Uint8Array>; conversationId: string; _idPromise: Promise<string> }>}
   */
  async chatCompletion(messages, options = {}) {
    if (options.token) this._token = options.token;
    const mode = mapModel(options.model);
    const query = messagesToText(messages);

    const conversationId = `temp-${randomUUID()}`;
    // 新版 /api/search/chat 请求体
    const body = {
      model: mode === 'concise' ? 'concise' : 'fast_thinking',
      stream: true,
      messages: [{
        id: `temp-${randomUUID()}`,
        key: `temp-${randomUUID()}`,
        conversationId,
        role: 'user',
        content: query,
        markdownContent: query,
        engineType: '',
        filter: 'all',
        contentType: 0,
        outputHtml: false,
        mode,
        model: mode === 'concise' ? 'concise' : 'fast_thinking',
        outputStyle: '正常',
      }],
      engineType: '',
      mode,
      filter: 'all',
      outputHtml: false,
      outputStyle: '正常',
      darkMode: false,
    };

    const res = await httpRequest(`${BASE_URL}/api/search/chat`, {
      method: 'POST',
      headers: this._headers({ Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Metaso chatCompletion failed: ${res.status} ${errText.slice(0, 300)}`);
    }

    // 从 conversation_init 事件中提取 convId
    const { stream, idPromise } = createIdExtractingPassthrough(res.body, (obj) => {
      if (obj.type === 'conversation_init' && obj.data?.id) {
        return String(obj.data.id);
      }
      return null;
    });

    const tracker = options.tracker;
    idPromise.then((cid) => {
      if (tracker && cid) {
        tracker.record(cid, this.name, () => this.deleteConversation(cid));
      }
    });

    return { stream, conversationId: '', _idPromise: idPromise };
  }
}
