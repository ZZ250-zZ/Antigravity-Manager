/**
 * DeepSeek PoW (Proof of Work) 挑战求解器。
 *
 * DeepSeek 的 chat API 要求在每次请求前先解一道 SHA3 哈希挑战。
 * 流程：
 *   1. POST /api/v0/chat/create_pow_challenge → 获取 challenge 配置
 *   2. 暴力搜索 nonce，使 SHA3-256(challenge + prefix + nonce) 满足 difficulty 要求
 *   3. 将 solution 编码为 base64 JSON 放入 x-ds-pow-response header
 *
 * 使用 Node.js 内置 crypto 模块的 SHA3-256（不依赖 WASM）。
 */

import { createHash } from 'node:crypto';

/**
 * 求解 PoW 挑战
 * @param {object} challenge  服务端返回的挑战配置
 * @param {string} challenge.algorithm   算法（应为 "DeepSeekHashV1" 或类似）
 * @param {string} challenge.challenge   挑战字符串
 * @param {string} challenge.salt        盐值
 * @param {number} challenge.difficulty  难度（前导零位数）
 * @param {number} challenge.expire_at   过期时间戳
 * @param {string} challenge.signature   服务端签名
 * @param {string} challenge.target_path 目标 API 路径
 * @returns {string} base64 编码的解答 JSON，可直接放入 x-ds-pow-response header
 */
export function solveChallenge(challenge) {
  const {
    algorithm = 'DeepSeekHashV1',
    challenge: challengeStr,
    salt,
    difficulty,
    expire_at,
    signature,
    target_path,
  } = challenge;

  const prefix = `${salt}_${expire_at}_`;

  // difficulty 表示哈希值前 N 位必须为 0（以 bit 为单位）
  // 转换为需要检查的前导零字节数和剩余位掩码
  const fullBytes = Math.floor(difficulty / 8);
  const remainBits = difficulty % 8;

  let nonce = 0;
  const maxAttempts = 1e9;

  while (nonce < maxAttempts) {
    const input = `${challengeStr}${prefix}${nonce}`;
    const hash = createHash('sha3-256').update(input).digest();

    // 检查前 fullBytes 个字节是否全为 0
    let valid = true;
    for (let i = 0; i < fullBytes; i++) {
      if (hash[i] !== 0) {
        valid = false;
        break;
      }
    }

    // 检查剩余位（高位必须为 0）
    if (valid && remainBits > 0) {
      const mask = (0xff << (8 - remainBits)) & 0xff;
      if ((hash[fullBytes] & mask) !== 0) {
        valid = false;
      }
    }

    if (valid) {
      const solution = {
        algorithm,
        challenge: challengeStr,
        salt,
        answer: nonce,
        signature,
        target_path,
      };
      return Buffer.from(JSON.stringify(solution)).toString('base64');
    }

    nonce++;
  }

  throw new Error(`DeepSeek PoW: 超过最大尝试次数 ${maxAttempts}`);
}
