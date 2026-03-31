/**
 * 讯飞星火 (Spark) Web API Provider: xinghuo.xfyun.cn
 *
 * 认证: ssoSessionId (从浏览器 Cookies 获取)
 *
 * 讯飞星火的 Web 端聊天使用内部 HTTP API (非官方 WebSocket API)。
 * 内部 API 通过 Cookie 认证，返回 SSE 流式响应。
 */

import { randomUUID } from 'node:crypto';
import { httpRequest } from '../http-client.mjs';
import { ConversationTracker } from '../utils/conversation-tracker.mjs';

const BASE_URL = 'https://xinghuo.xfyun.cn';

/** 模型映射 */
const MODEL_MAP = {
  spark: 'generalv3.5',
  'spark-ultra': 'Ultra',
  'spark-max': 'generalv3.5',
  'spark-pro': 'generalv3',
  'spark-lite': 'general',
};

function mapModel(model) {
  const m = (model ?? '').trim().toLowerCase();
  return MODEL_MAP[m] ?? 'generalv3.5';
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

/** 从 SSE 流中提取 chatId */
async function readChatIdFromStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let chatId = '';
  try {
    while (!chatId) {
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
          const cid = obj.chatId ?? obj.chat_id ?? obj.sid ?? obj.conversation_id;
          if (cid && typeof cid === 'string') {
            chatId = cid;
            break;
          }
        } catch { /* ignore */ }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return chatId;
}

export class SparkProvider {
  /**
   * @param {string} token ssoSessionId (从浏览器 Cookies 获取)
   */
  constructor(token) {
    /** @private */
    this._token = token;
  }

  get name() {
    return 'spark';
  }

  /** @private */
  _headers(extra = {}) {
    return {
      'Content-Type': 'application/json',
      Cookie: `ssoSessionId=${this._token}`,
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      ...extra,
    };
  }

  async deleteConversation(chatId) {
    const res = await httpRequest(`${BASE_URL}/iflygpt-chat/u/chat_list/delete`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ chatListId: chatId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Spark deleteConversation failed: ${res.status} ${text.slice(0, 200)}`);
    }
  }

  /**
   * @param {Array<{ role: string; content?: unknown }>} messages
   * @param {{ token?: string; model?: string; stream?: boolean; tracker?: ConversationTracker }} [options]
   * @returns {Promise<{ stream: ReadableStream<Uint8Array>; conversationId: string }>}
   */
  async chatCompletion(messages, options = {}) {
    if (options.token) this._token = options.token;
    const userText = messagesToText(messages);

    // 创建新的聊天
    const createRes = await httpRequest(`${BASE_URL}/iflygpt-chat/u/chat_list/create`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({}),
    });

    let chatListId = '';
    if (createRes.ok) {
      const data = await createRes.json().catch(() => null);
      chatListId = data?.data?.id ?? '';
    }

    // 发送消息
    const body = {
      chatListId,
      content: userText,
      GtToken: '',
      clientType: 1,
    };

    const res = await httpRequest(`${BASE_URL}/iflygpt-chat/u/chat/send_text`, {
      method: 'POST',
      headers: this._headers({ Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Spark chatCompletion failed: ${res.status} ${errText.slice(0, 300)}`);
    }

    const convId = chatListId || randomUUID();
    const tracker = options.tracker;
    if (tracker && chatListId) {
      tracker.record(chatListId, this.name, () => this.deleteConversation(chatListId));
    }

    return { stream: res.body, conversationId: convId };
  }
}
