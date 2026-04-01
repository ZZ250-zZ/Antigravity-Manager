/**
 * 阶跃星辰 StepChat Web API Provider: www.stepfun.com
 *
 * 认证: 完整 Cookie 字符串（含 Oasis-Token、Oasis-Webid 等）
 * 协议: Connect Protocol (gRPC-web 变体) — 二进制帧编码
 * 流程: CreateChatSession → ChatStream（Connect） → SSE 格式转换
 *
 * Token 格式: 用户注册时传入完整 cookie 字符串
 *
 * 响应帧类型:
 *   startEvent       — 消息开始，含 messageId
 *   messageEvent     — 消息元数据（模型信息等）
 *   pipelineEvent    — 流水线阶段（推理开始/结束等）
 *   reasoningEvent   — 推理/思考文本（增量）
 *   textEvent        — 正式回复文本（增量）
 *   heartBeatEvent   — 心跳
 *   messageDoneEvent — 消息完成
 *   doneEvent        — 流结束
 */

import { httpRequest } from '../http-client.mjs';
import { ConversationTracker } from '../utils/conversation-tracker.mjs';
import { registerSSEProcessor } from '../converters/sse-registry.mjs';

const BASE_URL = 'https://www.stepfun.com';

const MODEL_MAP = {
  step: 'step-auto',
  stepchat: 'step-auto',
  'step-auto': 'step-auto',
  'step-2': 'step-2-16k',
  'step-flash': 'step3.5-flash',
  'step-3': 'step3.5-flash',
};

function mapModel(model) {
  const m = (model ?? '').trim().toLowerCase();
  return MODEL_MAP[m] ?? 'step-auto';
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

/** 将 OpenAI messages 合并成单个 prompt（Step Web API 只接受单条用户消息） */
function messagesToPrompt(messages) {
  const parts = [];
  for (const msg of messages) {
    const text = normalizeMessageContent(msg.content);
    if (msg.role === 'system') {
      parts.push(`[System]\n${text}`);
    } else if (msg.role === 'assistant') {
      parts.push(`[Assistant]\n${text}`);
    } else {
      parts.push(text);
    }
  }
  return parts.join('\n\n');
}

/**
 * 将 JSON payload 编码为 Connect Protocol 帧
 * 帧格式: 1 字节 flags + 4 字节长度（big-endian）+ payload
 */
function encodeConnectFrame(payload) {
  const payloadBytes = new TextEncoder().encode(payload);
  const frame = new Uint8Array(5 + payloadBytes.length);
  frame[0] = 0x00;
  const len = payloadBytes.length;
  frame[1] = (len >> 24) & 0xff;
  frame[2] = (len >> 16) & 0xff;
  frame[3] = (len >> 8) & 0xff;
  frame[4] = len & 0xff;
  frame.set(payloadBytes, 5);
  return frame;
}

/**
 * 将 Connect Protocol 二进制流转换为 SSE 格式的 ReadableStream。
 * 提取 textEvent 作为内容 delta，格式化为 SSE data 行。
 * 这样下游 native-to-openai 转换器可以像处理 SSE 一样处理 Step 的响应。
 */
function connectStreamToSSE(connectStream) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let frameBuffer = new Uint8Array(0);

  return new TransformStream({
    transform(chunk, controller) {
      // 拼接到 buffer
      const newBuf = new Uint8Array(frameBuffer.length + chunk.length);
      newBuf.set(frameBuffer);
      newBuf.set(chunk, frameBuffer.length);
      frameBuffer = newBuf;

      // 逐帧解析
      while (frameBuffer.length >= 5) {
        // const flags = frameBuffer[0];
        const fLen =
          (frameBuffer[1] << 24) |
          (frameBuffer[2] << 16) |
          (frameBuffer[3] << 8) |
          frameBuffer[4];
        if (frameBuffer.length < 5 + fLen) break;

        const frameData = decoder.decode(frameBuffer.slice(5, 5 + fLen));
        frameBuffer = frameBuffer.slice(5 + fLen);

        try {
          const obj = JSON.parse(frameData);
          const event = obj.data?.event;
          if (!event) continue;

          // textEvent → 正式回复文本
          if (event.textEvent && typeof event.textEvent.text === 'string') {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: event.textEvent.text })}\n\n`));
          }
          // messageDoneEvent / doneEvent → 结束
          if (event.messageDoneEvent || event.doneEvent) {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          }
        } catch {
          // 忽略解析错误
        }
      }
    },
    flush(controller) {
      // 确保发送结束标记
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    },
  });
}

export class StepProvider {
  /**
   * @param {string} token  完整 cookie 字符串
   */
  constructor(token) {
    /** @private */
    this._token = token;
  }

  get name() {
    return 'step';
  }

  /** @private Connect Protocol 请求头 */
  _headers(extra = {}) {
    return {
      'Content-Type': 'application/json',
      Cookie: this._token,
      'connect-protocol-version': '1',
      'oasis-appid': '10200',
      'oasis-language': 'zh',
      'oasis-platform': 'web',
      'x-waf-client-type': 'fetch_sdk',
      canary: 'false',
      Origin: BASE_URL,
      Referer: `${BASE_URL}/chats/new`,
      ...extra,
    };
  }

  /**
   * 创建聊天会话
   * @returns {Promise<string>} chatSessionId
   */
  async createSession() {
    const res = await httpRequest(
      `${BASE_URL}/api/agent/capy.agent.v1.AgentService/CreateChatSession`,
      { method: 'POST', headers: this._headers(), body: '{}' },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Step createSession failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const sessionId = data.chatSession?.chatSessionId || data.chatSessionId;
    if (!sessionId) throw new Error('Step createSession: missing chatSessionId');
    return sessionId;
  }

  /**
   * 删除聊天会话
   * @param {string} sessionId
   */
  async deleteConversation(sessionId) {
    const res = await httpRequest(
      `${BASE_URL}/api/agent/capy.agent.v1.AgentService/DeleteChatSession`,
      {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ chatSessionId: sessionId }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`Step deleteConversation: ${res.status} ${text.slice(0, 200)}`);
    }
  }

  /**
   * @param {Array<{ role: string; content?: unknown }>} messages
   * @param {{ token?: string; model?: string; stream?: boolean; tracker?: ConversationTracker }} [options]
   * @returns {Promise<{ stream: ReadableStream<Uint8Array>; conversationId: string }>}
   */
  async chatCompletion(messages, options = {}) {
    if (options.token) this._token = options.token;
    const prompt = messagesToPrompt(messages);
    const model = mapModel(options.model);

    // 1. 创建会话
    const sessionId = await this.createSession();

    // 2. 构建 Connect Protocol 请求
    const payload = JSON.stringify({
      message: {
        chatSessionId: sessionId,
        content: { userMessage: { qa: { content: prompt } } },
      },
      config: { model, enableReasoning: false, enableSearch: false },
    });
    const frame = encodeConnectFrame(payload);

    const res = await httpRequest(
      `${BASE_URL}/api/agent/capy.agent.v1.AgentService/ChatStream`,
      {
        method: 'POST',
        headers: this._headers({ 'Content-Type': 'application/connect+json' }),
        body: frame,
      },
    );

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Step chatCompletion failed: ${res.status} ${errText.slice(0, 300)}`);
    }

    // 3. Connect → SSE 转换
    const sseStream = res.body.pipeThrough(connectStreamToSSE());

    const tracker = options.tracker;
    if (tracker && sessionId) {
      tracker.record(sessionId, this.name, () => this.deleteConversation(sessionId));
    }

    return { stream: sseStream, conversationId: sessionId };
  }
}

// Step SSE：Connect 协议已在 connectStreamToSSE 中转为标准 SSE 格式
// 提取逻辑同 hailuo 通用 web 格式
registerSSEProcessor('step', {
  isRawPayload: false,
  extractDelta(parsed, state) {
    const oaiDelta = parsed.choices?.[0]?.delta?.content;
    if (typeof oaiDelta === 'string') return oaiDelta;
    if (typeof parsed.content === 'string') {
      const delta = parsed.content.slice(state.prevContent.length);
      state.prevContent = parsed.content;
      return delta || null;
    }
    if (typeof parsed.text === 'string') return parsed.text;
    if (typeof parsed.answer === 'string') {
      const delta = parsed.answer.slice(state.prevContent.length);
      state.prevContent = parsed.answer;
      return delta || null;
    }
    return null;
  },
  extractFullContent(parsed, prev) {
    const delta = parsed.choices?.[0]?.delta?.content;
    if (typeof delta === 'string') return prev + delta;
    if (typeof parsed.content === 'string') return parsed.content;
    if (typeof parsed.text === 'string') return prev + parsed.text;
    if (typeof parsed.answer === 'string') return parsed.answer;
    return prev;
  },
  isDone: () => false,
});
