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

/**
 * @param {string | URL} url
 * @param {import('wreq-js').RequestInit} [options]
 */
export async function httpRequest(url, options = {}) {
  const session = await getSession();
  return session.fetch(url, {
    ...options,
    headers: { ...defaultHeaders, ...headersToObject(options.headers) },
  });
}
