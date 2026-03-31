/**
 * 通用 OpenAI 兼容 API 代理 Provider。
 *
 * 适用于官方提供 OpenAI 兼容接口的厂商（百川、零一万物、商汤、天工等）。
 * 这些厂商的 API 使用 API Key 认证，直接代理 /chat/completions 请求。
 *
 * 与 Web 模式的区别：
 *   - Web 模式使用浏览器 Cookie/token，免费
 *   - API 模式使用 API Key，按量计费（部分有免费额度）
 */

import { httpRequest } from '../http-client.mjs';

/**
 * 创建一个 OpenAI 兼容 API Provider
 * @param {object} config
 * @param {string} config.name         Provider 名称
 * @param {string} config.baseUrl      API 基础 URL (如 https://api.baichuan-ai.com)
 * @param {string} config.defaultModel 默认模型名
 * @param {Record<string, string>} [config.modelMap]  模型映射表
 * @param {Record<string, string>} [config.extraHeaders]  额外请求头
 * @returns {new (apiKey: string) => Provider}
 */
export function createOpenAICompatibleProvider(config) {
  const { name, baseUrl, defaultModel, modelMap = {}, extraHeaders = {} } = config;

  return class OpenAICompatibleProvider {
    /**
     * @param {string} apiKey  官方 API Key
     */
    constructor(apiKey) {
      /** @private */
      this._apiKey = apiKey;
    }

    get name() {
      return name;
    }

    /** @private */
    _mapModel(model) {
      const m = (model ?? '').trim().toLowerCase();
      return modelMap[m] ?? model ?? defaultModel;
    }

    // API Key 模式无需删除会话
    async deleteConversation(_convId) {
      // no-op
    }

    /**
     * @param {Array<{ role: string; content?: unknown }>} messages
     * @param {{ token?: string; model?: string; stream?: boolean; tracker?: import('../utils/conversation-tracker.mjs').ConversationTracker }} [options]
     * @returns {Promise<{ stream: ReadableStream<Uint8Array>; conversationId: string }>}
     */
    async chatCompletion(messages, options = {}) {
      const apiKey = options.token ?? this._apiKey;
      const model = this._mapModel(options.model);

      const body = {
        model,
        messages,
        stream: true,
      };

      const res = await httpRequest(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => '');
        throw new Error(`${name} chatCompletion failed: ${res.status} ${errText.slice(0, 300)}`);
      }

      // 官方 API 已返回 OpenAI 格式，不需要转换
      return { stream: res.body, conversationId: '', _isOpenAIFormat: true };
    }
  };
}

// ─── 百川智能 ─────────────────────────────────────────────
export const BaichuanProvider = createOpenAICompatibleProvider({
  name: 'baichuan',
  baseUrl: 'https://api.baichuan-ai.com',
  defaultModel: 'Baichuan4',
  modelMap: {
    baichuan: 'Baichuan4',
    'baichuan-4': 'Baichuan4',
    'baichuan-3': 'Baichuan3-Turbo',
    'baichuan-turbo': 'Baichuan3-Turbo',
  },
});

// ─── 零一万物 (Yi) ────────────────────────────────────────
export const YiProvider = createOpenAICompatibleProvider({
  name: 'yi',
  baseUrl: 'https://api.lingyiwanwu.com',
  defaultModel: 'yi-lightning',
  modelMap: {
    yi: 'yi-lightning',
    'yi-lightning': 'yi-lightning',
    'yi-large': 'yi-large',
    'yi-medium': 'yi-medium',
    wanzhi: 'yi-lightning',
  },
});

// ─── 商汤 SenseNova ──────────────────────────────────────
export const SenseNovaProvider = createOpenAICompatibleProvider({
  name: 'sensenova',
  baseUrl: 'https://api.sensenova.cn/compatible-mode',
  defaultModel: 'SenseChat-5',
  modelMap: {
    sensenova: 'SenseChat-5',
    sensechat: 'SenseChat-5',
    'sensechat-5': 'SenseChat-5',
    shangtan: 'SenseChat-5',
  },
});

// ─── 天工 Tiangong ───────────────────────────────────────
export const TiangongProvider = createOpenAICompatibleProvider({
  name: 'tiangong',
  baseUrl: 'https://model-platform.tiangong.cn',
  defaultModel: 'SkyChat-MegaVerse',
  modelMap: {
    tiangong: 'SkyChat-MegaVerse',
    skychat: 'SkyChat-MegaVerse',
    'sky-chat': 'SkyChat-MegaVerse',
  },
});
