/**
 * 豆包 Web API：sessionid Cookie，query 带 msToken / a_bogus，SSE event_data 为 JSON 字符串。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { httpRequest } from '../http-client.mjs';
import { uuid } from '../utils/sign.mjs';
import { ConversationTracker } from '../utils/conversation-tracker.mjs';
import { createIdExtractingPassthrough } from '../utils/stream-id-extractor.mjs';

const DOUBAO_ORIGIN = 'https://www.doubao.com';
const COMPLETION_PATH = '/samantha/chat/completion';
const DELETE_THREAD_PATH = '/samantha/thread/delete';

/** 96 字节随机 → base64，作 msToken */
function fakeMsToken() {
  return randomBytes(96).toString('base64');
}

/** 与前端形态一致的 a_bogus 占位 */
function fakeABogus() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let r34 = '';
  for (let i = 0; i < 34; i++) r34 += alphabet[Math.floor(Math.random() * alphabet.length)];
  let r6 = '';
  for (let i = 0; i < 6; i++) r6 += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `mf-${r34}-${r6}`;
}

/**
 * @param {string} path
 * @param {string} msToken
 * @param {string} aBogus
 */
function buildDoubaoUrl(path, msToken, aBogus) {
  const u = new URL(`${DOUBAO_ORIGIN}${path}`);
  u.searchParams.set('aid', '497858');
  u.searchParams.set('device_id', String(Math.floor(Math.random() * 9e17 + 7e18)));
  u.searchParams.set('device_platform', 'web');
  u.searchParams.set('language', 'zh');
  u.searchParams.set('pkg_type', 'release_version');
  u.searchParams.set('real_aid', '497858');
  u.searchParams.set('region', 'CN');
  u.searchParams.set('samantha_web', '1');
  u.searchParams.set('sys_region', 'CN');
  u.searchParams.set('tea_uuid', String(Math.floor(Math.random() * 9e17 + 7e18)));
  u.searchParams.set('version_code', '20800');
  u.searchParams.set('web_id', String(Math.floor(Math.random() * 9e17 + 7e18)));
  u.searchParams.set('msToken', msToken);
  u.searchParams.set('a_bogus', aBogus);
  return u.toString();
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
 * OpenAI messages → 单条用户侧文本（content 为 JSON 字符串内嵌 text）
 * @param {Array<{ role: string; content?: unknown }>} messages
 */
function messagesToDoubaoText(messages) {
  const chunks = [];
  for (const msg of messages) {
    const text = normalizeMessageContent(msg.content);
    if (msg.role === 'system') {
      chunks.push(`[System]\n${text}`);
      continue;
    }
    if (msg.role === 'assistant') {
      chunks.push(`[Assistant]\n${text}`);
      continue;
    }
    chunks.push(text);
  }
  return chunks.join('\n\n');
}

function randomDigits14() {
  let s = '';
  for (let i = 0; i < 14; i++) s += String(Math.floor(Math.random() * 10));
  return s;
}

/**
 * 从 SSE 中解析 conversation_id（event_data 为 JSON 字符串）；2005 为错误
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {Promise<string>}
 */
async function readDoubaoConversationIdFromStream(stream) {
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
        if (!payload || payload === '[DONE]') continue;
        try {
          const outer = JSON.parse(payload);
          const et = outer.event_type;
          if (et === 2005) {
            let detail = 'unknown';
            try {
              const ed =
                typeof outer.event_data === 'string' ? JSON.parse(outer.event_data) : outer.event_data;
              detail = typeof ed === 'object' && ed && 'message' in ed ? String(ed.message) : JSON.stringify(ed);
            } catch {
              detail = String(outer.event_data).slice(0, 200);
            }
            throw new Error(`Doubao stream error (2005): ${detail.slice(0, 300)}`);
          }
          if (typeof outer.event_data !== 'string') continue;
          const ed = JSON.parse(outer.event_data);
          const cid = ed.conversation_id;
          if (cid && typeof cid === 'string' && cid !== '0') {
            convId = cid;
            break;
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith('Doubao stream error')) throw e;
        }
      }
    }
  } finally {
    // wreq-js 的 tee() 分支不兼容 cancel()，用 releaseLock 替代
    reader.releaseLock();
  }
  return convId;
}

export class DoubaoProvider {
  /**
   * @param {string} token sessionid
   */
  constructor(token) {
    /** @private */
    this._token = token;
  }

  get name() {
    return 'doubao';
  }

  /**
   * @param {string} conversationId
   */
  async deleteConversation(conversationId) {
    const sessionId = this._token;
    const msToken = fakeMsToken();
    const aBogus = fakeABogus();
    const url = buildDoubaoUrl(DELETE_THREAD_PATH, msToken, aBogus);
    const u32 = uuid();
    const flowTrace = `04-${u32}-${u32.substring(0, 16)}-01`;
    const res = await httpRequest(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `sessionid=${sessionId};sid_tt=${sessionId};is_staff_user=false;msToken=${msToken}`,
        Referer: `${DOUBAO_ORIGIN}/chat/`,
        Origin: DOUBAO_ORIGIN,
        'Agw-Js-Conv': 'str',
        'X-Flow-Trace': flowTrace,
      },
      body: JSON.stringify({ conversation_id: conversationId }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Doubao deleteConversation failed: ${res.status} ${errText.slice(0, 200)}`);
    }
  }

  /**
   * @param {Array<{ role: string; content?: unknown }>} messages
   * @param {{ token?: string; model?: string; stream?: boolean; tracker?: ConversationTracker }} [options]
   * @returns {Promise<{ stream: ReadableStream<Uint8Array>; conversationId: string }>}
   */
  async chatCompletion(messages, options = {}) {
    const sessionId = options.token ?? this._token;
    const msToken = fakeMsToken();
    const aBogus = fakeABogus();
    const url = buildDoubaoUrl(COMPLETION_PATH, msToken, aBogus);
    const u32 = uuid();
    const flowTrace = `04-${u32}-${u32.substring(0, 16)}-01`;
    const textPayload = messagesToDoubaoText(messages);
    const body = {
      messages: [
        {
          content: JSON.stringify({ text: textPayload }),
          content_type: 2001,
          attachments: [],
          references: [],
        },
      ],
      completion_option: {
        is_regen: false,
        with_suggest: true,
        need_create_conversation: true,
        launch_stage: 1,
        is_replace: false,
        is_delete: false,
        message_from: 0,
        event_id: '0',
      },
      conversation_id: '0',
      local_conversation_id: `local_16${randomDigits14()}`,
      local_message_id: randomUUID(),
    };

    const res = await httpRequest(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `sessionid=${sessionId};sid_tt=${sessionId};is_staff_user=false;msToken=${msToken}`,
        Referer: `${DOUBAO_ORIGIN}/chat/`,
        Origin: DOUBAO_ORIGIN,
        'Agw-Js-Conv': 'str',
        'X-Flow-Trace': flowTrace,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Doubao chatCompletion failed: ${res.status} ${errText.slice(0, 300)}`);
    }

    // 用 passthrough 提取 conversation_id，避免 tee()（wreq-js tee 在 Windows 上有兼容问题）
    const { stream, idPromise } = createIdExtractingPassthrough(res.body, (outer) => {
      // 豆包的 event_data 是嵌套 JSON 字符串
      if (outer.event_type === 2005) return null; // 错误事件跳过
      if (typeof outer.event_data !== 'string') return null;
      try {
        const ed = JSON.parse(outer.event_data);
        const cid = ed.conversation_id;
        if (cid && typeof cid === 'string' && cid !== '0') return cid;
      } catch { /* ignore */ }
      return null;
    });

    const tracker = options.tracker;
    idPromise.then((conversationId) => {
      if (tracker && conversationId) {
        tracker.record(conversationId, this.name, () => this.deleteConversation(conversationId));
      }
    });

    return { stream, conversationId: '', _idPromise: idPromise };
  }
}
