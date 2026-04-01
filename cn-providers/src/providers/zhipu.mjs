/**
 * 智谱清言（ChatGLM）Web API：chatglm_token + X-Sign WAF 签名认证，SSE 流式。
 *
 * 认证: chatglm_token（JWT） + X-Sign（MD5 签名）
 * 签名算法: MD5("{modifiedTimestamp}-{nonce}-{salt}")
 *   - modifiedTimestamp: 将 Date.now() 的倒数第二位替换为 (数字和 - 原倒数第二位) % 10
 *   - nonce: UUID v4 去横杠
 *   - salt: 固定值 "8a1317a7468aa3ad86e997d08f3f31cb"
 *
 * SSE 响应格式 (每行 data:):
 *   { parts: [{ content: "全文", status: "..." }], conversation_id: "..." }
 */
import { createHash, randomUUID } from 'node:crypto';
import { httpRequest } from '../http-client.mjs';
import { ConversationTracker } from '../utils/conversation-tracker.mjs';
import { createIdExtractingPassthrough } from '../utils/stream-id-extractor.mjs';
import { registerSSEProcessor } from '../converters/sse-registry.mjs';

const ZHIPU_BASE = 'https://chatglm.cn';
const ZHIPU_STREAM = `${ZHIPU_BASE}/chatglm/backend-api/assistant/stream`;
const ZHIPU_DELETE = `${ZHIPU_BASE}/chatglm/backend-api/assistant/conversation/delete`;
const SIGN_SALT = '8a1317a7468aa3ad86e997d08f3f31cb';

/** 生成修改后的时间戳（倒数第二位替换为校验位） */
function makeTimestamp() {
  const raw = Date.now().toString();
  const len = raw.length;
  const digits = raw.split('').map(Number);
  const checksum = digits.reduce((a, b) => a + b, 0) - digits[len - 2];
  return raw.substring(0, len - 2) + (checksum % 10) + raw.substring(len - 1, len);
}

/** 生成 32 位 hex UUID（去横杠） */
function hexUUID() {
  return randomUUID().replace(/-/g, '');
}

/** 生成 X-Sign 签名三元组 */
function generateSign() {
  const timestamp = makeTimestamp();
  const xNonce = hexUUID();
  const sign = createHash('md5').update(`${timestamp}-${xNonce}-${SIGN_SALT}`).digest('hex');
  return { timestamp, xNonce, sign };
}

/** 模型 → assistant_id */
const ASSISTANT_MAP = {
  'glm-4': '65940acff94777010aa6b796',
  chatglm: '65940acff94777010aa6b796',
  zhipu: '65940acff94777010aa6b796',
  'glm-4-zero': '676411c38945bbc58a905d31',
  'glm-zero': '676411c38945bbc58a905d31',
};

function mapAssistantId(model) {
  const m = (model ?? '').trim().toLowerCase();
  return ASSISTANT_MAP[m] ?? '65940acff94777010aa6b796';
}

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

/** OpenAI → 智谱 messages（content 为 [{ type, text }]） */
function messagesToZhipu(messages) {
  const out = [];
  for (const msg of messages) {
    const text = normalizeMessageContent(msg.content);
    if (msg.role === 'system') {
      out.push({ role: 'user', content: [{ type: 'text', text: `[System]\n${text}` }] });
      continue;
    }
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    out.push({ role, content: [{ type: 'text', text }] });
  }
  return out;
}

export class ZhipuProvider {
  /**
   * @param {string} token chatglm_token（JWT access token）
   */
  constructor(token) {
    /** @private */
    this._token = token;
    /** @private 持久化 device-id，整个实例生命周期不变 */
    this._deviceId = hexUUID();
  }

  get name() {
    return 'zhipu';
  }

  /** @private 构建请求头（包含 X-Sign WAF 签名） */
  _headers(extra = {}) {
    const { timestamp, xNonce, sign } = generateSign();
    return {
      Authorization: `Bearer ${this._token}`,
      'Content-Type': 'application/json',
      'App-Name': 'chatglm',
      'X-Device-Id': this._deviceId,
      'X-App-Platform': 'pc',
      'X-App-Version': '0.0.1',
      'X-Request-Id': hexUUID(),
      'X-Timestamp': timestamp,
      'X-Nonce': xNonce,
      'X-Sign': sign,
      Origin: ZHIPU_BASE,
      Referer: `${ZHIPU_BASE}/main/chatfree`,
      ...extra,
    };
  }

  /**
   * @param {string} conversationId
   * @param {string} [assistantId]
   */
  async deleteConversation(conversationId, assistantId) {
    const aid = assistantId ?? mapAssistantId(undefined);
    const res = await httpRequest(ZHIPU_DELETE, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({
        assistant_id: aid,
        conversation_id: conversationId,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`Zhipu deleteConversation: ${res.status} ${errText.slice(0, 200)}`);
    }
  }

  /**
   * @param {Array<{ role: string; content?: unknown }>} messages
   * @param {{ token?: string; model?: string; stream?: boolean; tracker?: ConversationTracker }} [options]
   * @returns {Promise<{ stream: ReadableStream<Uint8Array>; conversationId: string }>}
   */
  async chatCompletion(messages, options = {}) {
    if (options.token) this._token = options.token;
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
        is_networking: false,
        input_question_type: 'xxxx',
        is_test: false,
        platform: 'pc',
      },
    };

    const res = await httpRequest(ZHIPU_STREAM, {
      method: 'POST',
      headers: this._headers({ Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
      timeoutMs: 0,
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Zhipu chatCompletion failed: ${res.status} ${errText.slice(0, 300)}`);
    }

    // 从 SSE 流中提取 conversation_id
    const { stream, idPromise } = createIdExtractingPassthrough(res.body, (obj) =>
      (obj.conversation_id && typeof obj.conversation_id === 'string') ? obj.conversation_id : null,
    );

    const tracker = options.tracker;
    idPromise.then((conversationId) => {
      if (tracker && conversationId) {
        tracker.record(conversationId, this.name, () =>
          this.deleteConversation(conversationId, assistantId),
        );
      }
    });

    return { stream, conversationId: '', _idPromise: idPromise };
  }
}

// 智谱 SSE：parts[0].content 为全文，需算 delta
registerSSEProcessor('zhipu', {
  isRawPayload: false,

  extractDelta(parsed, state) {
    const parts = parsed.parts;
    if (!Array.isArray(parts) || !parts.length) return null;
    const c = parts[0].content;
    const full = typeof c === 'string' ? c
      : (Array.isArray(c) && c[0]?.text) ? c[0].text
      : null;
    if (full === null) return null;
    const delta = full.slice(state.prevContent.length);
    state.prevContent = full;
    return delta || null;
  },

  extractFullContent(parsed, prev) {
    const parts = parsed.parts;
    if (!Array.isArray(parts) || !parts.length) return prev;
    const c = parts[0].content;
    const text = typeof c === 'string' ? c
      : (Array.isArray(c) && c[0]?.text) ? c[0].text
      : null;
    return text ?? prev;
  },

  isDone(_parsed) {
    return false;
  },
});
