/**
 * 腾讯元宝 (Yuanbao) Web API Provider: yuanbao.tencent.com
 *
 * 认证: 使用浏览器中的完整 Cookie 字符串（包含 QQ/微信登录后的认证信息）
 *
 * 腾讯元宝的 Web API 不做 TLS 指纹检测，但需要特定的请求头。
 * API 端点: https://yuanbao.tencent.com/api/chat/
 */

import { randomUUID } from 'node:crypto';
import { httpRequest } from '../http-client.mjs';
import { ConversationTracker } from '../utils/conversation-tracker.mjs';

const BASE_URL = 'https://yuanbao.tencent.com';

/** 模型映射 */
const MODEL_MAP = {
  yuanbao: 'gpt_175B_0404',
  'yuanbao-deepseek': 'deep_seek_v3',
  'yuanbao-hunyuan': 'gpt_175B_0404',
};

function mapModel(model) {
  const m = (model ?? '').trim().toLowerCase();
  return MODEL_MAP[m] ?? 'gpt_175B_0404';
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
          const cid = obj.chatId ?? obj.chat_id ?? obj.id ?? obj.conversation_id;
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

export class YuanbaoProvider {
  /**
   * @param {string} token  浏览器 Cookie 字符串 (完整的，包含认证信息)
   */
  constructor(token) {
    /** @private */
    this._token = token;
  }

  get name() {
    return 'yuanbao';
  }

  /** @private */
  _headers(extra = {}) {
    return {
      'Content-Type': 'application/json',
      Cookie: this._token,
      Origin: BASE_URL,
      Referer: `${BASE_URL}/chat/`,
      ...extra,
    };
  }

  async deleteConversation(chatId) {
    const res = await httpRequest(`${BASE_URL}/api/chat/delete`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ chatId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Yuanbao deleteConversation failed: ${res.status} ${text.slice(0, 200)}`);
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
    const modelId = mapModel(options.model);

    const body = {
      prompt: userText,
      model: modelId,
      chatId: '',
      displayPrompt: userText,
      multimedia: [],
      plugin: '',
    };

    const res = await httpRequest(`${BASE_URL}/api/chat/${randomUUID()}`, {
      method: 'POST',
      headers: this._headers({ Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Yuanbao chatCompletion failed: ${res.status} ${errText.slice(0, 300)}`);
    }

    const [forParse, forClient] = res.body.tee();
    const conversationId = await readChatIdFromStream(forParse);

    const tracker = options.tracker;
    if (tracker && conversationId) {
      tracker.record(conversationId, this.name, () => this.deleteConversation(conversationId));
    }

    return { stream: forClient, conversationId: conversationId || '' };
  }
}
