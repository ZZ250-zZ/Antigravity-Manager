/**
 * 统一 HTTP 出口：wreq-js Session（edge_145 + Windows），供各 provider 复用 TLS 指纹。
 * createSession 为异步，使用惰性单例避免重复建连。
 */
import { createSession } from 'wreq-js';

/** @type {Promise<import('wreq-js').Session> | null} */
let sessionPromise = null;

function getSession() {
  if (!sessionPromise) {
    // wreq-js 2.x 使用 browser/os，等价于旧版 impersonate 语义
    sessionPromise = createSession({ browser: 'edge_145', os: 'windows' });
  }
  return sessionPromise;
}

const defaultHeaders = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0',
  Accept: '*/*',
};

/** 将 HeadersInit 转为普通对象，便于与默认头合并 */
function headersToObject(headers) {
  if (!headers) return {};
  if (typeof headers.forEach === 'function') {
    const o = {};
    headers.forEach((v, k) => {
      o[k] = v;
    });
    return o;
  }
  return { ...headers };
}

// 默认请求超时（毫秒），防止上游 API 挂起导致无限等待
// SSE 流式请求应传入 timeoutMs: 0 来禁用超时
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * @param {string | URL} url
 * @param {import('wreq-js').RequestInit & { timeoutMs?: number }} [options]
 *   timeoutMs: 超时毫秒数。0 = 不设超时（适用于 SSE 流式请求）。默认 30s。
 */
export async function httpRequest(url, options = {}) {
  const session = await getSession();
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOpts } = options;

  if (timeoutMs <= 0) {
    // SSE 等长连接场景，不设超时
    return session.fetch(url, {
      ...fetchOpts,
      headers: { ...defaultHeaders, ...headersToObject(fetchOpts.headers) },
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await session.fetch(url, {
      ...fetchOpts,
      headers: { ...defaultHeaders, ...headersToObject(fetchOpts.headers) },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
