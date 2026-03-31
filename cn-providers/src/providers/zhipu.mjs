/**
 * 智谱清言（ChatGLM）Web API：chatglm_refresh_token + X-Sign 刷新 access，SSE 流式。
 */
import { generateZhipuSign, uuid } from '../utils/sign.mjs';
import { httpRequest } from '../http-client.mjs';
import { ConversationTracker } from '../utils/conversation-tracker.mjs';

const ZHIPU_REFRESH = 'https://chatglm.cn/chatglm/user-api/user/refresh';
const ZHIPU_STREAM = 'https://chatglm.cn/chatglm/backend-api/assistant/stream';
const ZHIPU_DELETE = 'https://chatglm.cn/chatglm/backend-api/assistant/conversation/delete';

/** 模型 → assistant_id */
const ASSISTANT_MAP = {
  'glm-4': '65940acff94777010aa6b796',
  chatglm: '65940acff94777010aa6b796',
  'glm-4-zero': '676411c38945bbc58a905d31',
  'glm-zero': '676411c38945bbc58a905d31',
};

/**
 * @param {string | undefined} model
 * @returns {string}
 */
function mapAssistantId(model) {
  const m = (model ?? '').trim().toLowerCase();
  return ASSISTANT_MAP[m] ?? '65940acff94777010aa6b796';
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
 * OpenAI → 智谱 messages（content 为 [{ type, text }]）
 * @param {Array<{ role: string; content?: unknown }>} messages
 */
function messagesToZhipu(messages) {
  /** @type {Array<{ role: string; content: Array<{ type: string; text: string }> }>} */
  const out = [];
  for (const msg of messages) {
    const text = normalizeMessageContent(msg.content);
    if (msg.role === 'system') {
      out.push({
        role: 'user',
        content: [{ type: 'text', text: `[System]\n${text}` }],
      });
      continue;
    }
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    out.push({ role, content: [{ type: 'text', text }] });
  }
  return out;
}

/**
 * 智谱鉴权头：每次请求重新算 X-Sign
 * @param {string} accessToken
 * @param {{ acceptSse?: boolean }} [extra]
 */
function buildZhipuHeaders(accessToken, extra = {}) {
  const { sign, nonce, ts } = generateZhipuSign();
  /** @type {Record<string, string>} */
  const h = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'X-Sign': sign,
    'X-Nonce': nonce,
    'X-Timestamp': ts,
    'App-Name': 'chatglm',
    'X-App-Platform': 'pc',
    'X-App-Version': '0.0.1',
    'X-App-Fr': 'default',
    'X-Lang': 'zh',
    'X-Device-Id': uuid(),
    'X-Request-Id': uuid(),
  };
  if (extra.acceptSse) h.Accept = 'text/event-stream';
  return h;
}

/**
 * 从 SSE 流中提取首个 conversation_id（与 Qwen 的 tee 用法一致）
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {Promise<string>}
 */
async function readConversationIdFromZhipuStream(stream) {
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
          if (obj.conversation_id && typeof obj.conversation_id === 'string') {
            convId = obj.conversation_id;
            break;
          }
        } catch {
          // ignore
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return convId;
}

export class ZhipuProvider {
  /**
   * @param {string} token chatglm_refresh_token
   */
  constructor(token) {
    /** @private */
    this._token = token;
  }

  get name() {
    return 'zhipu';
  }

  /**
   * @param {string} [refreshTokenArg]
   * @returns {Promise<{ accessToken: string; expiresIn?: number }>}
   */
  async refreshToken(refreshTokenArg) {
    const rt = refreshTokenArg ?? this._token;
    const res = await httpRequest(ZHIPU_REFRESH, {
      method: 'POST',
      headers: buildZhipuHeaders(rt),
      body: '{}',
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Zhipu refreshToken failed: ${res.status} ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    const result = data.result;
    const accessToken =
      result && typeof result === 'object'
        ? result.accessToken ?? result.access_token
        : undefined;
    if (!accessToken || typeof accessToken !== 'string') {
      throw new Error('Zhipu refreshToken: missing access token in response');
    }
    return { accessToken, expiresIn: 3600 };
  }

  /**
   * @param {string} conversationId
   * @param {string} [assistantId] 须与创建会话时一致（如 glm-zero）；默认 glm-4
   */
  async deleteConversation(conversationId, assistantId) {
    const { accessToken } = await this.refreshToken();
    const aid = assistantId ?? mapAssistantId(undefined);
    const res = await httpRequest(ZHIPU_DELETE, {
      method: 'POST',
      headers: buildZhipuHeaders(accessToken),
      body: JSON.stringify({
        assistant_id: aid,
        conversation_id: conversationId,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Zhipu deleteConversation failed: ${res.status} ${errText.slice(0, 200)}`);
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
    const assistantId = mapAssistantId(options.model);
    const zhipuMessages = messagesToZhipu(messages);

    const body = {
      assistant_id: assistantId,
      conversation_id: '',
      project_id: '',
      chat_type: 'user_chat',
      messages: zhipuMessages,
      meta_data: {
        cogview: { rm_label_watermark: false },
        channel: '',
        draft_id: '',
        chat_mode: 'zero',
        is_networking: false,
        input_question_type: 'xxxx',
        is_test: false,
        platform: 'pc',
        quote_log_id: '',
      },
    };

    const res = await httpRequest(ZHIPU_STREAM, {
      method: 'POST',
      headers: buildZhipuHeaders(accessToken, { acceptSse: true }),
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Zhipu chatCompletion failed: ${res.status} ${errText.slice(0, 300)}`);
    }

    const [forParse, forClient] = res.body.tee();
    const conversationIdPromise = readConversationIdFromZhipuStream(forParse);
    const conversationId = await conversationIdPromise;

    const tracker = options.tracker;
    if (tracker && conversationId) {
      tracker.record(conversationId, this.name, () =>
        this.deleteConversation(conversationId, assistantId),
      );
    }

    return { stream: forClient, conversationId };
  }
}
