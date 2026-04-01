/**
 * OpenCode Zen 免费模型 Provider。
 *
 * 上游地址: https://opencode.ai/zen/v1
 * 认证: 免费模型无需认证（不发 Authorization/Origin/Referer 头）
 * 协议: OpenAI 兼容格式，响应无需转换
 * 容错: 429 限流自动重试（指数退避，最多 3 次）
 * 模型: 启动时从 /v1/models 动态获取，定期刷新（默认 30 分钟）
 *
 * 参考: https://github.com/zz6zz666/openclaw-opencode-free-plugin
 */

import { httpRequest } from '../http-client.mjs';

const ZEN_BASE = 'https://opencode.ai/zen/v1';

/** 429 重试配置 */
const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000;
const MAX_DELAY_MS = 8000;

/** 模型列表刷新间隔（毫秒） */
const MODEL_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

// 动态模型列表缓存（模块级单例）
let _cachedModels = [];
let _lastFetchTime = 0;
let _fetchPromise = null;

/**
 * 从上游 /v1/models 获取完整模型列表
 * @returns {Promise<Array<{id: string, object: string, created: number, owned_by: string}>>}
 */
async function fetchUpstreamModels() {
  try {
    const res = await httpRequest(`${ZEN_BASE}/models`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      console.warn(`[opencode] Failed to fetch models: ${res.status}`);
      return _cachedModels;
    }
    const data = await res.json();
    const models = data?.data ?? [];
    console.log(`[opencode] Fetched ${models.length} models from upstream`);
    return models;
  } catch (e) {
    console.warn(`[opencode] Model fetch error: ${e.message}`);
    return _cachedModels;
  }
}

/**
 * 获取模型列表（带缓存 + 去重获取保护）
 * @param {boolean} [force=false] 强制刷新
 * @returns {Promise<Array<{id: string, object: string, created: number, owned_by: string}>>}
 */
export async function getModels(force = false) {
  const now = Date.now();
  if (!force && _cachedModels.length > 0 && now - _lastFetchTime < MODEL_REFRESH_INTERVAL_MS) {
    return _cachedModels;
  }
  // 避免并发重复获取
  if (_fetchPromise) return _fetchPromise;
  _fetchPromise = fetchUpstreamModels()
    .then((models) => {
      if (models.length > 0) {
        _cachedModels = models;
        _lastFetchTime = Date.now();
      }
      return _cachedModels;
    })
    .finally(() => { _fetchPromise = null; });
  return _fetchPromise;
}

/**
 * 获取所有 OpenCode 模型的 oc-* 前缀 ID 列表（供 router 动态注册）
 * @returns {Promise<string[]>}
 */
export async function getModelIds() {
  const models = await getModels();
  return models.map((m) => `oc-${m.id}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenCodeProvider {
  /**
   * @param {string} _token 占位，OpenCode 免认证
   */
  constructor(_token) {
    // 免认证，token 仅为满足 ProviderRouter 接口约束
  }

  get name() {
    return 'opencode';
  }

  // 免认证 API 无会话概念，无需删除
  async deleteConversation(_convId) {}

  /**
   * @param {Array<{ role: string; content?: unknown }>} messages
   * @param {{ model?: string; stream?: boolean }} [options]
   * @returns {Promise<{ stream: ReadableStream<Uint8Array>; conversationId: string; _isOpenAIFormat: boolean }>}
   */
  async chatCompletion(messages, options = {}) {
    // oc-xxx → xxx（去掉前缀发给上游）
    const model = (options.model ?? '').trim().toLowerCase();
    const upstreamModel = model.replace(/^oc-/, '');

    const body = JSON.stringify({
      model: upstreamModel,
      messages,
      stream: true,
    });

    // 不发 Origin/Referer：API 模式不需要浏览器头，发了反而触发认证校验
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };

    // 429 指数退避重试
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(INITIAL_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS);
        console.warn(`[opencode] 429 rate limited, retry ${attempt}/${MAX_RETRIES} after ${delay}ms`);
        await sleep(delay);
      }

      const res = await httpRequest(`${ZEN_BASE}/chat/completions`, {
        method: 'POST',
        headers,
        body,
        timeoutMs: 0, // SSE 长连接不设超时
      });

      if (res.status === 429 && attempt < MAX_RETRIES) {
        lastError = new Error(`OpenCode rate limited (429)`);
        continue;
      }

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => '');
        throw new Error(`OpenCode chatCompletion failed: ${res.status} ${errText.slice(0, 300)}`);
      }

      // 上游已是 OpenAI 格式，直接透传
      return { stream: res.body, conversationId: '', _isOpenAIFormat: true };
    }

    throw lastError ?? new Error('OpenCode: max retries exceeded');
  }
}
