/**
 * Kimi（月之暗面）Web API：refresh_token 换 access_token，先建会话再 SSE 流式补全。
 */
import { httpRequest } from '../http-client.mjs';
import { ConversationTracker } from '../utils/conversation-tracker.mjs';
import { registerSSEProcessor } from '../converters/sse-registry.mjs';

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
   * @param {string} token refresh_token 或 access_token（kimi-auth cookie）
   */
  constructor(token) {
    /** @private */
    this._token = token;
    /** @private 缓存的 access_token */
    this._accessToken = null;
  }

  get name() {
    return 'kimi';
  }

  /**
   * 获取可用的 access_token：
   * 1. 先尝试直接用 _token 作为 access_token 调用 /api/user 验证
   * 2. 验证失败则当作 refresh_token 去 refresh 接口换取
   * @param {string} [tokenArg]
   * @returns {Promise<{ accessToken: string; expiresIn?: number }>}
   */
  async refreshToken(tokenArg) {
    const token = tokenArg ?? this._token;
    
    // 如果已缓存 access_token，直接返回
    if (this._accessToken) {
      return { accessToken: this._accessToken, expiresIn: 3600 };
    }
    
    // 先尝试直接作为 access_token 使用（验证是否有效）
    try {
      const verifyRes = await httpRequest(`${KIMI_BASE}/api/user`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (verifyRes.ok) {
        // token 本身就是有效的 access_token
        this._accessToken = token;
        return { accessToken: token, expiresIn: 3600 };
      }
    } catch { /* 验证失败，继续 refresh 流程 */ }

    // 作为 refresh_token 使用，换取 access_token
    const res = await httpRequest(`${KIMI_BASE}/api/auth/token/refresh`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Kimi refreshToken failed: ${res.status} ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    if (data.refresh_token && typeof data.refresh_token === 'string') {
      this._token = data.refresh_token;
    }
    this._accessToken = data.access_token;
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

// Kimi SSE：event=cmpl 时 text 为增量；event=all_done 时结束
registerSSEProcessor('kimi', {
  isRawPayload: false,

  extractDelta(parsed, _state) {
    if (parsed.event === 'all_done') return null;
    if (parsed.event === 'cmpl' && typeof parsed.text === 'string') return parsed.text;
    return null;
  },

  extractFullContent(parsed, prev) {
    if (parsed.event === 'cmpl' && typeof parsed.text === 'string') return prev + parsed.text;
    return prev;
  },

  isDone(parsed) {
    return parsed.event === 'all_done';
  },
});
