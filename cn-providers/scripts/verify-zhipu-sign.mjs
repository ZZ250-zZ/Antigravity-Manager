#!/usr/bin/env node
/**
 * 验证 Zhipu X-Sign 算法正确性
 * 在浏览器中生成签名，同时用 Node.js 生成签名，对比结果
 */
import { chromium } from 'playwright';
import { createHash, randomUUID } from 'node:crypto';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

/** Node.js 端生成修改后的时间戳 */
function makeTimestamp(now) {
  const A = now.toString();
  const e = A.length;
  const n = A.split('').map(Number);
  const i = n.reduce((a, b) => a + b, 0) - n[e - 2];
  return A.substring(0, e - 2) + (i % 10) + A.substring(e - 1, e);
}

/** Node.js 端 MD5 */
function md5(str) {
  return createHash('md5').update(str).digest('hex');
}

/** Node.js 端生成签名 */
function generateSign(timestamp, nonce) {
  const raw = `${timestamp}-${nonce}-8a1317a7468aa3ad86e997d08f3f31cb`;
  return md5(raw);
}

async function main() {
  // 本地测试
  const now = Date.now();
  const ts = makeTimestamp(now);
  const nonce = randomUUID().replace(/-/g, '');
  const sign = generateSign(ts, nonce);
  console.log('=== Node.js 本地生成 ===');
  console.log(`  now:       ${now}`);
  console.log(`  timestamp: ${ts}`);
  console.log(`  nonce:     ${nonce}`);
  console.log(`  sign:      ${sign}`);

  // 浏览器端验证
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const page = await context.newPage();

  await page.goto('https://chatglm.cn/main/chatfree', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // 获取浏览器的 o0() 结果
  const browserResult = await page.evaluate(() => {
    const chunks = window.webpackChunkzp_chat_glm;
    if (!Array.isArray(chunks)) return { error: 'no chunks' };

    // 直接查找并执行模块 93990 的 w 函数逻辑
    const now = Date.now();
    const A = now.toString();
    const e = A.length;
    const n = A.split('').map(Number);
    const i = n.reduce((a, b) => a + b, 0) - n[e - 2];
    const t = A.substring(0, e - 2) + (i % 10) + A.substring(e - 1, e);

    return { now, timestamp: t, rawTimestamp: A };
  });

  console.log('\n=== 浏览器端时间戳验证 ===');
  console.log(`  now:          ${browserResult.now}`);
  console.log(`  rawTimestamp:  ${browserResult.rawTimestamp}`);
  console.log(`  modTimestamp:  ${browserResult.timestamp}`);

  // 获取常量值（X-App-Platform 等）
  console.log('\n=== 获取 header 常量 ===');
  const constants = await page.evaluate(() => {
    const chunks = window.webpackChunkzp_chat_glm;
    if (!Array.isArray(chunks)) return {};

    // 找模块 63484
    for (let ci = 0; ci < chunks.length; ci++) {
      const mods = chunks[ci][1];
      if (!mods || !mods['63484']) continue;

      const mod = { exports: {} };
      try {
        const requireFn = (id) => ({});
        requireFn.d = (exports, defs) => {
          for (const key in defs) {
            Object.defineProperty(exports, key, { get: defs[key], enumerable: true });
          }
        };
        requireFn.r = () => {};
        mods['63484'](mod, mod.exports, requireFn);
        return {
          exports: Object.keys(mod.exports),
          values: Object.fromEntries(
            Object.entries(mod.exports).filter(([, v]) => typeof v !== 'function')
          ),
        };
      } catch (e) {
        return { error: e.message };
      }
    }
    return { error: 'module not found' };
  });
  console.log('模块 63484 导出:', JSON.stringify(constants, null, 2));

  // 获取 X-App-fr 值
  const appFr = await page.evaluate(() => {
    const chunks = window.webpackChunkzp_chat_glm;
    if (!Array.isArray(chunks)) return null;

    for (let ci = 0; ci < chunks.length; ci++) {
      const mods = chunks[ci][1];
      if (!mods || !mods['47997']) continue;
      const src = mods['47997'].toString();
      // 找到 $Y 函数
      const match = src.match(/\$Y.*?function.*?\{(.*?)\}/s);
      if (match) return match[0].slice(0, 500);
    }
    return null;
  });
  console.log('\n$Y (X-App-fr) 函数:', appFr);

  // 实际发起请求验证
  console.log('\n=== 实际发送测试请求 ===');
  const testResult = await page.evaluate(async () => {
    const now = Date.now();
    const A = now.toString();
    const e = A.length;
    const n = A.split('').map(Number);
    const sumDigits = n.reduce((a, b) => a + b, 0);
    const i = sumDigits - n[e - 2];
    const timestamp = A.substring(0, e - 2) + (i % 10) + A.substring(e - 1, e);

    // 生成 UUID
    const nonce = crypto.randomUUID().replace(/-/g, '');
    const requestId = crypto.randomUUID().replace(/-/g, '');

    // 获取 token
    const getCookie = (name) => {
      const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return match ? decodeURIComponent(match[1]) : null;
    };
    const token = getCookie('chatglm_token');
    if (!token) return { error: 'no chatglm_token cookie' };

    // 使用 SubtleCrypto 计算 MD5？不行，SubtleCrypto 不支持 MD5
    // 尝试使用页面中已有的 MD5 库
    let md5Fn = null;
    const chunks = window.webpackChunkzp_chat_glm;
    for (let ci = 0; ci < chunks.length; ci++) {
      const mods = chunks[ci][1];
      if (!mods) continue;
      // 模块 55569 是 MD5 库
      if (mods['55569']) {
        const mod = { exports: {} };
        try {
          const req = (id) => {
            // 可能需要依赖，先返回空
            return {};
          };
          req.r = () => {};
          req.d = (exports, defs) => {
            for (const key in defs) {
              Object.defineProperty(exports, key, { get: defs[key], enumerable: true });
            }
          };
          req.n = (m) => () => m;
          mods['55569'](mod, mod.exports, req);
          if (typeof mod.exports === 'function') {
            md5Fn = mod.exports;
          } else if (mod.exports.default && typeof mod.exports.default === 'function') {
            md5Fn = mod.exports.default;
          }
        } catch (e) {
          // 尝试另一种方式
        }
        break;
      }
    }

    if (!md5Fn) {
      // 简单实现 MD5（或使用内联的）
      return { error: 'MD5 function not available', token: token.slice(0, 20) + '...' };
    }

    const sign = md5Fn(`${timestamp}-${nonce}-8a1317a7468aa3ad86e997d08f3f31cb`);

    // 发送请求
    const resp = await fetch('https://chatglm.cn/chatglm/user-api/user/info', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'App-Name': 'chatglm',
        'X-Device-Id': requestId,
        'X-App-Platform': 'pc',
        'X-App-Version': '0.0.1',
        'X-Request-Id': requestId,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
        'X-Sign': sign,
      },
    });

    const data = await resp.json();
    return {
      status: resp.status,
      signUsed: sign,
      timestampUsed: timestamp,
      nonceUsed: nonce,
      responseStatus: data.status,
      responseMessage: data.message,
      userName: data.result?.name,
    };
  });
  console.log('测试结果:', JSON.stringify(testResult, null, 2));

  // 获取 device-id（从一个实际请求中捕获的）
  console.log('\n=== 获取 Device-Id ===');
  const deviceId = await page.evaluate(() => {
    // 模块 47997 的 IP() 函数生成 device-id
    // 实际是从 localStorage 获取或生成
    return localStorage.getItem('deviceId') || localStorage.getItem('device_id') || 'not found in localStorage';
  });
  console.log('Device-Id from localStorage:', deviceId);

  await page.close();
  browser.close();
}

main().catch(e => console.error(e.message));
