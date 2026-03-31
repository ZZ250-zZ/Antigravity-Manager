/**
 * 阶跃星辰 StepChat Web API Provider: stepchat.cn / yuewen.cn
 *
 * 认证: Oasis-Token (从浏览器 Cookies 获取)
 *       可选 deviceId (从 LocalStorage 获取)
 *       Token 格式: "deviceId@Oasis-Token" 或单独 "Oasis-Token"
 *
 * StepChat 使用 Bearer Token 认证 + SSE 流式响应。
 */

import { randomUUID } from 'node:crypto';
import { httpRequest } from '../http-client.mjs';
import { ConversationTracker } from '../utils/conversation-tracker.mjs';

const BASE_URL = 'https://stepchat.cn';

/** 模型映射 */
const MODEL_MAP = {
  step: 'step',
  stepchat: 'step',
  'step-2': 'step',
  'step-flash': 'step',
};

function mapModel(model) {
  const m = (model ?? '').trim().toLowerCase();
  return MODEL_MAP[m] ?? 'step';
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

function messagesToStepFormat(messages) {
  const out = [];
  for (const msg of messages) {
    const text = normalizeMessageContent(msg.content);
    if (msg.role === 'system') {
      out.push({ role: 'user', content: `[System]\n${text}` });
      continue;
    }
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    out.push({ role, content: text });
  }
  return out;
}

/** 解析 token: 可能是 "deviceId@OasisToken" 格式 */
function parseToken(rawToken) {
  if (rawToken.includes('@')) {
    const idx = rawToken.indexOf('@');
    return {
      deviceId: rawToken.slice(0, idx),
      oasisToken: rawToken.slice(idx + 1),
    };
  }
  return { deviceId: '', oasisToken: rawToken };
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
          const cid = obj.conversation_id ?? obj.chat_id ?? obj.id;
          if (cid && typeof cid === 'string') {
            convId = cid;
            break;
          }
        } catch { /* ignore */ }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return convId;
}

export class StepProvider {
  /**
   * @param {string} token  Oasis-Token 或 "deviceId@Oasis-Token"
   */
  constructor(token) {
    /** @private */
    this._token = token;
  }

  get name() {
    return 'step';
  }

  /** @private */
  _headers(extra = {}) {
    const { deviceId, oasisToken } = parseToken(this._token);
    const h = {
      Authorization: `Bearer ${oasisToken}`,
      'Content-Type': 'application/json',
      'Oasis-Token': oasisToken,
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      ...extra,
    };
    if (deviceId) h['X-Device-Id'] = deviceId;
    return h;
  }

  async deleteConversation(convId) {
    const res = await httpRequest(`${BASE_URL}/api/chat/${encodeURIComponent(convId)}`, {
      method: 'DELETE',
      headers: this._headers(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Step deleteConversation failed: ${res.status} ${text.slice(0, 200)}`);
    }
  }

  /**
   * @param {Array<{ role: string; content?: unknown }>} messages
   * @param {{ token?: string; model?: string; stream?: boolean; tracker?: ConversationTracker }} [options]
   * @returns {Promise<{ stream: ReadableStream<Uint8Array>; conversationId: string }>}
   */
  async chatCompletion(messages, options = {}) {
    if (options.token) this._token = options.token;
    const stepMessages = messagesToStepFormat(messages);

    // 先创建会话
    const createRes = await httpRequest(`${BASE_URL}/api/chat/create`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ name: '' }),
    });
    let convId = '';
    if (createRes.ok) {
      const createData = await createRes.json().catch(() => null);
      convId = createData?.data?.id ?? createData?.id ?? '';
    }

    // 发送消息
    const body = {
      messages: stepMessages,
      conversation_id: convId,
      chat_type: 'search_chat',
    };

    const res = await httpRequest(`${BASE_URL}/api/chat/completion`, {
      method: 'POST',
      headers: this._headers({ Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Step chatCompletion failed: ${res.status} ${errText.slice(0, 300)}`);
    }

    // 如果创建时没拿到 convId，从 SSE 流中解析
    if (!convId) {
      const [forParse, forClient] = res.body.tee();
      convId = await readConvIdFromStream(forParse);

      const tracker = options.tracker;
      if (tracker && convId) {
        tracker.record(convId, this.name, () => this.deleteConversation(convId));
      }
      return { stream: forClient, conversationId: convId };
    }

    const tracker = options.tracker;
    if (tracker && convId) {
      tracker.record(convId, this.name, () => this.deleteConversation(convId));
    }
    return { stream: res.body, conversationId: convId };
  }
}
