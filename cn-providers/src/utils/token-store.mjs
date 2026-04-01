/**
 * Token 本地持久化存储
 *
 * 将从 CDP 提取的 token 保存到本地 JSON 文件，
 * 避免每次启动都重新提取。
 *
 * 存储路径：~/.antigravity_tools/cn_provider_tokens.json
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STORE_DIR = join(homedir(), '.antigravity_tools');
const STORE_FILE = join(STORE_DIR, 'cn_provider_tokens.json');

/**
 * 加载已保存的 token
 * @returns {Promise<Record<string, { token: string; extractedAt: string; lastUsedAt?: string }>>}
 */
export async function loadTokens() {
  try {
    const data = await readFile(STORE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/**
 * 保存 token 到本地文件
 * @param {Record<string, { token: string; extractedAt: string; lastUsedAt?: string }>} tokens
 */
export async function saveTokens(tokens) {
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(STORE_FILE, JSON.stringify(tokens, null, 2), 'utf-8');
}

/**
 * 更新单个 provider 的 token
 * @param {string} providerName
 * @param {string} token
 */
export async function updateToken(providerName, token) {
  const tokens = await loadTokens();
  tokens[providerName] = {
    token,
    extractedAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };
  await saveTokens(tokens);
}

/**
 * 标记某个 provider 的 token 为过期
 * @param {string} providerName
 */
export async function markExpired(providerName) {
  const tokens = await loadTokens();
  if (tokens[providerName]) {
    tokens[providerName].expired = true;
    tokens[providerName].expiredAt = new Date().toISOString();
    await saveTokens(tokens);
  }
}

/**
 * 批量更新 token（从 CDP 提取后调用）
 * @param {Record<string, string>} tokenMap { providerName: token }
 */
export async function batchUpdateTokens(tokenMap) {
  const existing = await loadTokens();
  const now = new Date().toISOString();
  for (const [name, token] of Object.entries(tokenMap)) {
    existing[name] = {
      token,
      extractedAt: now,
      // 清除过期标记
      // expired: undefined,
      // expiredAt: undefined,
    };
  }
  await saveTokens(existing);
}

/**
 * 获取有效（未过期）的 token 列表
 * @returns {Promise<Record<string, string>>} { providerName: token }
 */
export async function getValidTokens() {
  const tokens = await loadTokens();
  const result = {};
  for (const [name, info] of Object.entries(tokens)) {
    if (!info.expired && info.token) {
      result[name] = info.token;
    }
  }
  return result;
}

export { STORE_FILE };
