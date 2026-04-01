/**
 * DeepSeek PoW (Proof of Work) 挑战求解器。
 *
 * DeepSeek 使用自定义 SHA3 变体（WASM 实现），Node.js 内置 crypto 的
 * sha3-256 / keccak-256 均无法匹配。因此直接加载 DeepSeek 官方 WASM
 * 模块 (sha3_wasm_bg.wasm) 来求解。
 *
 * 流程：
 *   1. POST /api/v0/chat/create_pow_challenge → 获取 challenge 配置
 *   2. 调用 WASM wasm_solve(challenge, prefix, difficulty)
 *   3. 将 solution 编码为 base64 JSON 放入 x-ds-pow-response header
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, 'sha3_wasm_bg.wasm');

// 懒加载 WASM 实例（只编译一次）
let _wasmInstance = null;

async function getWasm() {
  if (_wasmInstance) return _wasmInstance;
  const wasmBytes = readFileSync(WASM_PATH);
  const module = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(module, {});
  _wasmInstance = instance.exports;
  return _wasmInstance;
}

/**
 * 将字符串写入 WASM 线性内存，返回 [ptr, len]
 */
function writeStringToWasm(wasm, str) {
  const encoded = new TextEncoder().encode(str);
  const len = encoded.length;
  // __wbindgen_export_0(size, align) → ptr
  const ptr = wasm.__wbindgen_export_0(len, 1);
  const mem = new Uint8Array(wasm.memory.buffer);
  mem.set(encoded, ptr);
  return [ptr, len];
}

/**
 * 求解 PoW 挑战
 * @param {object} challenge  服务端返回的挑战配置
 * @returns {string} base64 编码的解答 JSON
 */
export async function solveChallenge(challenge) {
  const {
    algorithm = 'DeepSeekHashV1',
    challenge: challengeStr,
    salt,
    difficulty,
    expire_at,
    signature,
    target_path,
  } = challenge;

  if (algorithm !== 'DeepSeekHashV1') {
    throw new Error(`DeepSeek PoW: unsupported algorithm ${algorithm}`);
  }

  const wasm = await getWasm();
  const prefix = `${salt}_${expire_at}_`;

  // wasm_solve(retptr, challPtr, challLen, prefixPtr, prefixLen, difficulty)
  // 返回: retptr+0 → i32 status (0=未找到, 1=找到), retptr+8 → f64 nonce
  const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
  try {
    const [challPtr, challLen] = writeStringToWasm(wasm, challengeStr);
    const [prefixPtr, prefixLen] = writeStringToWasm(wasm, prefix);

    wasm.wasm_solve(retptr, challPtr, challLen, prefixPtr, prefixLen, difficulty);

    const mem = new DataView(wasm.memory.buffer);
    const status = mem.getInt32(retptr, true);
    const nonce = mem.getFloat64(retptr + 8, true);

    if (status === 0) {
      throw new Error(`DeepSeek PoW: 在 ${difficulty} 次迭代内未找到解`);
    }

    const answer = Math.floor(nonce);
    const solution = {
      algorithm,
      challenge: challengeStr,
      salt,
      answer,
      signature,
      target_path,
    };
    return Buffer.from(JSON.stringify(solution)).toString('base64');
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
}
