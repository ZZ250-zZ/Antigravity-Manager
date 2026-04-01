#!/usr/bin/env node
/**
 * 下载 DeepSeek 的 SHA3 WASM 模块，直接在 Node.js 中调用 wasm_solve。
 * 如果成功，将 WASM 保存到项目中供 provider 使用。
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
const WASM_PATH = join(__dirname, '..', 'src', 'utils', 'sha3_wasm_bg.wasm');

async function downloadWasm() {
  if (existsSync(WASM_PATH)) {
    console.log('WASM already exists:', WASM_PATH);
    return readFileSync(WASM_PATH);
  }
  console.log('Downloading WASM from:', WASM_URL);
  const res = await fetch(WASM_URL);
  if (!res.ok) throw new Error(`Failed to download WASM: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(WASM_PATH, buf);
  console.log('Saved WASM:', buf.length, 'bytes');
  return buf;
}

async function main() {
  const wasmBytes = await downloadWasm();
  
  // 实例化 WASM
  const module = await WebAssembly.compile(wasmBytes);
  const exports_list = WebAssembly.Module.exports(module);
  console.log('\nWASM exports:', exports_list.map(e => `${e.name}(${e.kind})`).join(', '));

  // 需要提供 imports（wbindgen 相关）
  const imports = {};
  const importDescriptors = WebAssembly.Module.imports(module);
  console.log('WASM imports:', importDescriptors.map(i => `${i.module}.${i.name}(${i.kind})`).join(', '));

  // 创建 import 对象
  for (const imp of importDescriptors) {
    if (!imports[imp.module]) imports[imp.module] = {};
    if (imp.kind === 'function') {
      imports[imp.module][imp.name] = () => { throw new Error(`Unimplemented import: ${imp.module}.${imp.name}`); };
    }
  }

  const instance = await WebAssembly.instantiate(module, imports);
  const wasm = instance.exports;
  console.log('\nInstance created. Available functions:', Object.keys(wasm).filter(k => typeof wasm[k] === 'function'));

  // 写入字符串到 WASM 内存
  function writeString(str) {
    const encoded = new TextEncoder().encode(str);
    const len = encoded.length;
    const ptr = wasm.__wbindgen_export_0(len, 1);
    const mem = new Uint8Array(wasm.memory.buffer);
    mem.set(encoded, ptr);
    return [ptr, len];
  }

  // 获取 challenge 用于测试
  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  let page = context.pages().find(p => { try { return new URL(p.url()).origin === 'https://chat.deepseek.com'; } catch { return false; } });
  let nc = false;
  if (!page) { page = await context.newPage(); nc = true; await page.goto('https://chat.deepseek.com', { waitUntil: 'domcontentloaded', timeout: 15000 }); await page.waitForTimeout(2000); }
  const token = await page.evaluate(() => { const v = localStorage.getItem('userToken'); try { return JSON.parse(v)?.value || v; } catch { return v; } });
  if (nc) await page.close();
  browser.close();

  const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
  const res = await fetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
    method: 'POST', headers, body: JSON.stringify({ target_path: '/api/v0/chat/completion' })
  });
  const data = await res.json();
  const raw = data?.data?.biz_data;
  const ch = raw?.challenge && typeof raw.challenge === 'object' ? raw.challenge : raw;
  console.log('\nChallenge:', JSON.stringify(ch).slice(0, 200));

  const { challenge, salt, difficulty, expire_at } = ch;
  const prefix = `${salt}_${expire_at}_`;

  // 调用 wasm_solve
  try {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
    const [challPtr, challLen] = writeString(challenge);
    const [prefixPtr, prefixLen] = writeString(prefix);
    
    console.log('Calling wasm_solve...');
    const start = Date.now();
    wasm.wasm_solve(retptr, challPtr, challLen, prefixPtr, prefixLen, difficulty);
    
    const mem = new DataView(wasm.memory.buffer);
    const status = mem.getInt32(retptr, true);
    const answer = mem.getFloat64(retptr + 8, true);
    
    wasm.__wbindgen_add_to_stack_pointer(16);
    
    console.log('Status:', status, '(0=not found, 1=found)');
    console.log('Answer:', answer);
    console.log('Time:', Date.now() - start, 'ms');
    
    if (status !== 0) {
      // 构建 solution 并测试
      const solution = Buffer.from(JSON.stringify({
        algorithm: ch.algorithm,
        challenge: challenge,
        salt: salt,
        answer: Math.floor(answer),
        signature: ch.signature,
        target_path: ch.target_path,
      })).toString('base64');
      
      console.log('\nSolution:', Buffer.from(solution, 'base64').toString().slice(0, 200));
      
      // 发送测试请求
      const createRes = await fetch('https://chat.deepseek.com/api/v0/chat_session/create', { method: 'POST', headers, body: '{}' });
      const sid = (await createRes.json())?.data?.biz_data?.id;
      
      const compRes = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
        headers: { ...headers, Accept: 'text/event-stream', 'x-ds-pow-response': solution },
        body: JSON.stringify({ chat_session_id: sid, prompt: '你好', ref_file_ids: [], thinking_enabled: false, search_enabled: false }),
      });
      console.log('\nCompletion status:', compRes.status);
      const text = await compRes.text();
      console.log('Response:', text.slice(0, 500));
    }
  } catch (e) {
    console.error('WASM call error:', e.message);
  }
}

main().catch(console.error);
