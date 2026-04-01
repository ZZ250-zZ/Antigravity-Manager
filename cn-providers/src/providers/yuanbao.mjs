/**
 * 腾讯元宝 (Yuanbao) Web API Provider: yuanbao.tencent.com
 *
 * 认证: Cookie 中的 hy_user + hy_token，以及 _qimei_uuid42 作为设备标识。
 * 发送消息时客户端生成 UUID 作为会话 ID，SSE 响应格式为 data: {"type":"text","msg":"..."}。
 *
 * 关键头信息:
 *   X-AgentID, X-ID, T-UserID, X-device-id, X-HY93, X-Source, X-Platform
 *   chat 请求额外需要: Content-Type: text/plain;charset=UTF-8, chat_version, X-Timestamp
 *
 * 逆向验证: X-Uskey / X-Bus-Params-Md5 服务端不校验，可省略。
 */

import { randomUUID } from 'node:crypto';
import { httpRequest } from '../http-client.mjs';
import { ConversationTracker } from '../utils/conversation-tracker.mjs';
// import { createIdExtractingPassthrough } from '../utils/stream-id-extractor.mjs'; // 不再需要从流中提取 ID

const BASE_URL = 'https://yuanbao.tencent.com';
// 默认 agentId（元宝主对话 Agent）
const DEFAULT_AGENT_ID = 'naQivTmsDa';

/**
 * 模型映射: 外部模型名 → { chatModelId, model }
 * chatModelId 是元宝前端使用的模型标识, model 是后端引擎标识
 */
const MODEL_MAP = {
  'yuanbao':           { chatModelId: 'hunyuan_gpt_175B_0404', model: 'gpt_175B_0404' },
  'yuanbao-hunyuan':   { chatModelId: 'hunyuan_gpt_175B_0404', model: 'gpt_175B_0404' },
  'yuanbao-hunyuan-t1':{ chatModelId: 'hunyuan_t1',            model: 'gpt_175B_0404' },
  'yuanbao-deepseek':  { chatModelId: 'deep_seek_v3',          model: 'gpt_175B_0404' },
  'yuanbao-deepseek-r1':{ chatModelId: 'deep_seek',            model: 'gpt_175B_0404' },
};

function mapModel(model) {
  const m = (model ?? '').trim().toLowerCase();
  return MODEL_MAP[m] ?? MODEL_MAP['yuanbao-deepseek'];
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

/**
 * 从 Cookie 字符串中解析指定 cookie 值
 * @param {string} cookieStr 完整 Cookie 字符串
 * @param {string} name cookie 名
 * @returns {string}
 */
function parseCookie(cookieStr, name) {
  const match = cookieStr.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : '';
}

export class YuanbaoProvider {
  /**
   * @param {string} token  浏览器完整 Cookie 字符串
   */
  constructor(token) {
    this._token = token;
    // 从 Cookie 中提取关键标识（延迟解析）
    this._userId = '';
    this._deviceId = '';
  }

  get name() {
    return 'yuanbao';
  }

  /** 解析并缓存用户/设备标识 */
  _ensureParsed() {
    if (!this._userId) {
      this._userId = parseCookie(this._token, 'hy_user');
      this._deviceId = parseCookie(this._token, '_qimei_uuid42');
    }
  }

  /**
   * 通用请求头（模型列表、会话管理等 JSON 接口）
   */
  _commonHeaders() {
    this._ensureParsed();
    return {
      'Content-Type': 'application/json',
      Cookie: this._token,
      Origin: BASE_URL,
      Referer: `${BASE_URL}/chat/${DEFAULT_AGENT_ID}`,
      'X-Requested-With': 'XMLHttpRequest',
      'X-AgentID': DEFAULT_AGENT_ID,
      'X-ID': this._userId,
      'T-UserID': this._userId,
      'X-device-id': this._deviceId,
      'X-HY93': this._deviceId,
      'X-Source': 'web',
      'X-Platform': 'win',
      'X-Language': 'zh-CN',
    };
  }

  /**
   * Chat 专用请求头（Content-Type 为 text/plain，附带 chat_version 等）
   */
  _chatHeaders() {
    return {
      ...this._commonHeaders(),
      'Content-Type': 'text/plain;charset=UTF-8',
      'X-Timestamp': String(Date.now()),
      'chat_version': 'v1',
      'X-Input-Type': 'text',
    };
  }

  /**
   * 删除对话（best-effort，API 路径可能变更）
   */
  async deleteConversation(chatId) {
    try {
      // 尝试已知的删除端点
      const res = await httpRequest(`${BASE_URL}/api/user/agent/conversation/delete`, {
        method: 'POST',
        headers: this._commonHeaders(),
        body: JSON.stringify({ cid: chatId }),
      });
      if (!res.ok) {
        console.warn(`[Yuanbao] deleteConversation ${chatId}: ${res.status} (best-effort)`);
      }
    } catch (e) {
      console.warn(`[Yuanbao] deleteConversation error: ${e.message}`);
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
    const { chatModelId, model } = mapModel(options.model);

    // 客户端生成对话 ID
    const conversationId = randomUUID();

    const body = {
      model,
      prompt: userText,
      plugin: '',
      displayPrompt: userText,
      displayPromptType: 1,
      agentId: DEFAULT_AGENT_ID,
      isTemporary: false,
      projectId: '',
      chatModelId,
      supportFunctions: ['closeInternetSearch'],
      docOpenid: '',
      options: {
        imageIntention: {
          needIntentionModel: true,
          backendUpdateFlag: 2,
          intentionStatus: true,
        },
      },
      multimedia: [],
      supportHint: 1,
      chatModelExtInfo: JSON.stringify({
        modelId: chatModelId,
        subModelId: '',
        supportFunctions: { internetSearch: 'closeInternetSearch' },
      }),
      applicationIdList: [],
      version: 'v2',
      isAtomInput: false,
      offsetOfHour: 8,
      offsetOfMinute: 0,
    };

    const res = await httpRequest(`${BASE_URL}/api/chat/${conversationId}`, {
      method: 'POST',
      headers: this._chatHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Yuanbao chatCompletion failed: ${res.status} ${errText.slice(0, 300)}`);
    }

    // 注册会话追踪（ID 已知，无需从流中提取）
    const tracker = options.tracker;
    if (tracker) {
      tracker.record(conversationId, this.name, () => this.deleteConversation(conversationId));
    }

    return { stream: res.body, conversationId };
  }
}
