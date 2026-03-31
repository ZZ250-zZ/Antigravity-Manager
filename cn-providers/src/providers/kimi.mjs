/**
 * Kimi（月之暗面）Web API：refresh_token 换 access_token，先建会话再 SSE 流式补全。
 */
import { httpRequest } from '../http-client.mjs';
import { ConversationTracker } from '../utils/conversation-tracker.mjs';

const KIMI_BASE = 'https://kimi.moonshot.cn';

/** OpenAI 模型 id → kimiplus_id */
function mapKimiPlusId(model) {
  const m = (model ?? '').trim().toLowerCase();
  if (m === 'kimi-k1' || m === 'k1') return 'k1';
  return 'kimi';
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
 * OpenAI messages → Kimi messages（纯文本）
 * @param {Array<{ role: string; content?: unknown }>} messages
 */
function messagesToKimi(messages) {
  /** @type {Array<{ role: string; content: string }>} */
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

export class KimiProvider {
  /**
   * @param {string} token refresh_token
   */
  constructor(token) {
    /** @private */
    this._token = token;
  }

  get name() {
    return 'kimi';
  }

  /**
   * 用 refresh_token 换取 access_token（服务端可能轮换 refresh_token）
   * @param {string} [refreshTokenArg]
   * @returns {Promise<{ accessToken: string; expiresIn?: number }>}
   */
  async refreshToken(refreshTokenArg) {
    const rt = refreshTokenArg ?? this._token;
    const res = await httpRequest(`${KIMI_BASE}/api/auth/token/refresh`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${rt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: rt }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Kimi refreshToken failed: ${res.status} ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    if (data.refresh_token && typeof data.refresh_token === 'string') {
      this._token = data.refresh_token;
    }
    return {
      accessToken: data.access_token,
      expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 3600,
    };
  }

  /**
   * @param {string} convId
   */
  async deleteConversation(convId) {
    const { accessToken } = await this.refreshToken();
    const url = `${KIMI_BASE}/api/chat/${encodeURIComponent(convId)}`;
    const res = await httpRequest(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Kimi deleteConversation failed: ${res.status} ${errText.slice(0, 200)}`);
    }
  }

  /**
   * @param {Array<{ role: string; content?: unknown }>} messages
   * @param {{ token?: string; model?: string; stream?: boolean; tracker?: ConversationTracker }} [options]
   * @returns {Promise<{ stream: ReadableStream<Uint8Array>; conversationId: string }>}
   */
  async chatCompletion(messages, options = {}) {
    const rt = options.token ?? this._token;
    const { accessToken } = await this.refreshToken(rt);
    const kimiplusId = mapKimiPlusId(options.model);
    const kimiMessages = messagesToKimi(messages);

    const createRes = await httpRequest(`${KIMI_BASE}/api/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: '未命名会话', is_example: false }),
    });
    if (!createRes.ok) {
      const errText = await createRes.text().catch(() => '');
      throw new Error(`Kimi create chat failed: ${createRes.status} ${errText.slice(0, 300)}`);
    }
    const createData = await createRes.json();
    const convId = createData.id;
    if (!convId || typeof convId !== 'string') {
      throw new Error('Kimi create chat: missing conversation id');
    }

    const body = {
      messages: kimiMessages,
      refs: [],
      use_search: false,
      kimiplus_id: kimiplusId,
    };

    const res = await httpRequest(`${KIMI_BASE}/api/chat/${encodeURIComponent(convId)}/completion/stream`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Kimi chatCompletion failed: ${res.status} ${errText.slice(0, 300)}`);
    }

    const tracker = options.tracker;
    if (tracker && convId) {
      tracker.record(convId, this.name, () => this.deleteConversation(convId));
    }

    return { stream: res.body, conversationId: convId };
  }
}
