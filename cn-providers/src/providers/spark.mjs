/**
 * 讯飞星火 (Spark) Web API Provider: xinghuo.xfyun.cn
 *
 * 认证: ssoSessionId (从浏览器 Cookies 获取)
 *
 * 2026-04 逆向更新：
 *   - 创建对话：POST /iflygpt/u/chat-list/v1/create-chat-list (JSON)
 *   - 发送消息：POST /iflygpt-chat/u/chat_message/chat (multipart/form-data)
 *   - SSE 格式：data:<base64编码文本> ，结束标记为 data:<end>
 *   - GtToken 可以为空
 */

import { randomUUID } from 'node:crypto';
import { httpRequest } from '../http-client.mjs';
import { ConversationTracker } from '../utils/conversation-tracker.mjs';

const BASE_URL = 'https://xinghuo.xfyun.cn';

/** 模型映射（暂无法通过 API 选择模型，统一为默认模型） */
const MODEL_MAP = {
  spark: 'spark',
  'spark-ultra': 'spark',
  'spark-max': 'spark',
  'spark-pro': 'spark',
  'spark-lite': 'spark',
};

// function mapModel(model) {
//   const m = (model ?? '').trim().toLowerCase();
//   return MODEL_MAP[m] ?? 'spark';
// }

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
 * 构建 multipart/form-data body
 * wreq-js 不支持 FormData，手动拼接 boundary
 */
function buildMultipartBody(fields) {
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);
  const body = fields
    .map(({ name, value }) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`)
    .join('\r\n') + `\r\n--${boundary}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
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

  /** @private 通用 JSON API 请求头 */
  _jsonHeaders(referer = `${BASE_URL}/desk`) {
    return {
      'Content-Type': 'application/json',
      Cookie: `ssoSessionId=${this._token}`,
      Origin: BASE_URL,
      Referer: referer,
      'web-v': '0.1.0',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/plain, */*',
      'Lang-Code': 'zh',
      clientType: '1',
      Channel: '',
    };
  }

  /** 删除对话 — 路径待确认，当前为 best-effort */
  async deleteConversation(chatListId) {
    // 旧 API 已失效(404)，尝试新路径
    // 即使失败也不阻塞主流程
    try {
      const res = await httpRequest(`${BASE_URL}/iflygpt/u/chat-list/v1/delete-chat-list`, {
        method: 'POST',
        headers: this._jsonHeaders(),
        body: JSON.stringify({ chatListId }),
      });
      if (!res.ok) {
        console.log(`[spark] deleteConversation ${chatListId}: ${res.status} (non-fatal)`);
      }
    } catch (e) {
      console.log(`[spark] deleteConversation error: ${e.message} (non-fatal)`);
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

    // Step 1: 创建新的聊天会话
    const createRes = await httpRequest(`${BASE_URL}/iflygpt/u/chat-list/v1/create-chat-list`, {
      method: 'POST',
      headers: this._jsonHeaders(),
      body: JSON.stringify({}),
    });

    let chatListId = '';
    if (createRes.ok) {
      const data = await createRes.json().catch(() => null);
      chatListId = String(data?.data?.id ?? '');
    }
    if (!chatListId) {
      throw new Error('Spark: 创建对话失败');
    }

    // Step 2: 发送消息 — multipart/form-data 格式
    const { body, contentType } = buildMultipartBody([
      { name: 'fd', value: chatListId },
      { name: 'isBot', value: '0' },
      { name: 'capabilities', value: '' },
      { name: 'clientType', value: '1' },
      { name: 'text', value: userText },
      { name: 'chatId', value: chatListId },
      { name: 'options', value: JSON.stringify({ chatOption: { thinkPattern: 'auto' } }) },
      { name: 'GtToken', value: '' },
      { name: 'clientType', value: '1' },
    ]);

    const chatReferer = `${BASE_URL}/desk?chatId=${chatListId}`;
    const res = await httpRequest(`${BASE_URL}/iflygpt-chat/u/chat_message/chat`, {
      method: 'POST',
      headers: {
        Cookie: `ssoSessionId=${this._token}`,
        Origin: BASE_URL,
        Referer: chatReferer,
        'Content-Type': contentType,
        accept: 'text/event-stream',
        'Lang-Code': 'zh',
        clientType: '1',
        Challenge: '',
        Seccode: '',
        Validate: '',
        Botweb: '0',
      },
      body,
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Spark chatCompletion failed: ${res.status} ${errText.slice(0, 300)}`);
    }

    const tracker = options.tracker;
    if (tracker) {
      tracker.record(chatListId, this.name, () => this.deleteConversation(chatListId));
    }

    return { stream: res.body, conversationId: chatListId };
  }
}
