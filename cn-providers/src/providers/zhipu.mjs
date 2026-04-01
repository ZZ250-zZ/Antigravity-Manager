/**
 * 智谱清言（ChatGLM）Web API：chatglm_token 直接认证，SSE 流式。
 *
 * 认证: chatglm_token（从浏览器 Cookie 获取的 JWT）
 * 流程: 直接 POST stream API（自动创建会话）→ SSE 流式响应
 *
 * SSE 响应格式 (每行 data:):
 *   { parts: [{ content: "全文", status: "..." }], conversation_id: "..." }
 */
// import { generateZhipuSign, uuid } from '../utils/sign.mjs';
import { httpRequest } from '../http-client.mjs';
import { ConversationTracker } from '../utils/conversation-tracker.mjs';
import { createIdExtractingPassthrough } from '../utils/stream-id-extractor.mjs';

const ZHIPU_BASE = 'https://chatglm.cn';
const ZHIPU_STREAM = `${ZHIPU_BASE}/chatglm/backend-api/assistant/stream`;
const ZHIPU_DELETE = `${ZHIPU_BASE}/chatglm/backend-api/assistant/conversation/delete`;

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
  }

  get name() {
    return 'zhipu';
  }

  /** @private 构建请求头（不再需要签名） */
  _headers(extra = {}) {
    return {
      Authorization: `Bearer ${this._token}`,
      'Content-Type': 'application/json',
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
