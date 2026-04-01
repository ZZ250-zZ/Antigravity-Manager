#!/usr/bin/env node
/**
 * 诊断脚本：绕过 sidecar transformer，直接调用各 Provider 并输出原始 SSE 数据。
 * 用于定位各厂商实际返回的数据格式，以便修复 transformer。
 *
 * 用法：
 *   node scripts/debug-raw-sse.mjs                  # 测试有 cookie 的所有 provider
 *   node scripts/debug-raw-sse.mjs doubao deepseek  # 只测试指定的
 */

import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const targetProviders = new Set(process.argv.slice(2).map(s => s.toLowerCase()));

// 各 provider 的 token 提取配置（和 extract-cookies-cdp.mjs 保持一致）
const PROVIDER_CONFIGS = {
  qwen: {
    domain: ['.aliyun.com', '.qianwen.com'],
    cookieKeys: { tongyi_sso_ticket: 'qwen' },
  },
  doubao: {
    domain: ['.doubao.com'],
    cookieKeys: { sessionid: 'doubao' },
  },
  deepseek: {
    domain: ['.deepseek.com'],
    localStorageKeys: { userToken: 'deepseek' },
    localStorageUrl: 'https://chat.deepseek.com',
  },
  step: {
    domain: ['.stepchat.cn', '.stepfun.com', 'www.stepfun.com'],
    cookieKeys: { 'Oasis-Token': 'step' },
  },
  spark: {
    domain: ['.xfyun.cn'],
    cookieKeys: { ssoSessionId: 'spark' },
  },
  metaso: {
    domain: ['.metaso.cn'],
    combineKeys: { uid: null, sid: null },
    combineFormat: '{uid}-{sid}',
  },
  yuanbao: {
    domain: ['.tencent.com'],
    fullCookie: true,
  },
  kimi: {
    domain: ['.moonshot.cn', '.kimi.com', 'www.kimi.com'],
    cookieKeys: { 'kimi-auth': 'kimi' },
    localStorageKeys: { access_token: 'kimi' },
    localStorageUrl: 'https://www.kimi.com',
  },
  zhipu: {
    domain: ['.chatglm.cn', '.zhipu.ai'],
    cookieKeys: { chatglm_refresh_token: 'zhipu' },
  },
};

async function extractTokens(context) {
  const tokens = {};
  for (const [providerName, config] of Object.entries(PROVIDER_CONFIGS)) {
    if (targetProviders.size > 0 && !targetProviders.has(providerName)) continue;

    if (config.cookieKeys) {
      const cookies = await context.cookies();
      for (const [cookieName, tokenName] of Object.entries(config.cookieKeys)) {
        const cookie = cookies.find(
          (c) => c.name === cookieName && config.domain.some((d) => c.domain.includes(d.replace(/^\./, '')))
        );
        if (cookie?.value) tokens[providerName] = cookie.value;
      }
    }

    if (config.combineKeys) {
      const cookies = await context.cookies();
      const parts = {};
      let allFound = true;
      for (const key of Object.keys(config.combineKeys)) {
        const cookie = cookies.find(
          (c) => c.name === key && config.domain.some((d) => c.domain.includes(d.replace(/^\./, '')))
        );
        if (cookie?.value) { parts[key] = cookie.value; } else { allFound = false; }
      }
      if (allFound) {
        let combined = config.combineFormat;
        for (const [k, v] of Object.entries(parts)) combined = combined.replace(`{${k}}`, v);
        tokens[providerName] = combined;
      }
    }

    if (config.fullCookie) {
      const cookies = await context.cookies();
      const domainCookies = cookies.filter((c) =>
        config.domain.some((d) => c.domain.includes(d.replace(/^\./, '')))
      );
      if (domainCookies.length > 0) {
        tokens[providerName] = domainCookies.map((c) => `${c.name}=${c.value}`).join('; ');
      }
    }

    if (config.localStorageKeys && !tokens[providerName]) {
      try {
        let page = context.pages().find((p) => {
          try { return new URL(p.url()).origin === new URL(config.localStorageUrl).origin; } catch { return false; }
        });
        let needClose = false;
        if (!page) {
          page = await context.newPage();
          needClose = true;
          await page.goto(config.localStorageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(2000);
        }
        for (const [lsKey] of Object.entries(config.localStorageKeys)) {
          const val = await page.evaluate((key) => localStorage.getItem(key), lsKey);
          if (val) {
            let finalVal = val;
            try { const p = JSON.parse(val); if (p?.value) finalVal = p.value; } catch {}
            tokens[providerName] = finalVal;
          }
        }
        if (needClose) await page.close();
      } catch {}
    }
  }
  return tokens;
}

/** 直接测试一个 provider：调用 sidecar 但捕获原始 SSE 并输出 */
async function testProviderDirect(providerName, token) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${providerName}] token: ${token.slice(0, 20)}...`);
  console.log(`${'='.repeat(60)}`);

  // 先注册 token
  const SIDECAR = `http://127.0.0.1:${process.env.CN_PROVIDERS_PORT || '8046'}`;
  try {
    await fetch(`${SIDECAR}/v1/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: providerName, token }),
    });
  } catch (e) {
    console.log(`  ⚠ 注册 token 失败: ${e.message}`);
    return;
  }

  // 发送非流式请求（拿到完整 JSON 响应更容易分析）
  // 但同时也测试流式
  const testModel = {
    qwen: 'qwen', doubao: 'doubao', deepseek: 'deepseek-chat',
    step: 'stepchat', spark: 'spark', metaso: 'metaso',
    yuanbao: 'yuanbao', kimi: 'kimi', zhipu: 'glm-4',
    hailuo: 'hailuo',
  }[providerName] ?? providerName;

  // 流式测试
  try {
    console.log(`\n  --- 流式请求 (model=${testModel}) ---`);
    const res = await fetch(`${SIDECAR}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: testModel,
        messages: [{ role: 'user', content: '你好' }],
        stream: true,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.log(`  ❌ HTTP ${res.status}: ${errText.slice(0, 500)}`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let dataLines = 0;
    let fullContent = '';
    const MAX_DISPLAY = 20;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        dataLines++;
        const payload = trimmed.slice(5).trimStart();

        if (dataLines <= MAX_DISPLAY) {
          const disp = payload.length > 300 ? payload.slice(0, 300) + '...' : payload;
          console.log(`  [${dataLines}] ${disp}`);
        }

        if (payload !== '[DONE]' && payload) {
          try {
            const obj = JSON.parse(payload);
            const delta = obj.choices?.[0]?.delta?.content;
            if (delta) fullContent += delta;
          } catch {}
        }
      }
    }

    console.log(`\n  📊 共 ${dataLines} 条 SSE data`);
    if (fullContent) {
      console.log(`  ✅ 回复: ${fullContent.slice(0, 150)}`);
    } else {
      console.log(`  ⚠ 未提取到文本内容`);
    }
  } catch (e) {
    console.log(`  ❌ 请求错误: ${e.message}`);
  }
}

async function main() {
  console.log('=== 原始 SSE 诊断 ===\n');

  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
    console.log(`✅ 已连接 CDP`);
  } catch (e) {
    console.error(`❌ CDP 连接失败: ${e.message}`);
    process.exit(1);
  }

  const context = browser.contexts()[0];
  if (!context) { console.error('❌ 无浏览器上下文'); process.exit(1); }

  const tokens = await extractTokens(context);
  console.log(`\n找到 ${Object.keys(tokens).length} 个 provider 的 token:`);
  for (const [name, token] of Object.entries(tokens)) {
    console.log(`  ${name}: ${token.slice(0, 25)}...`);
  }

  // 逐个测试
  for (const [name, token] of Object.entries(tokens)) {
    await testProviderDirect(name, token);
  }

  browser.close();
  console.log('\n完成。');
}

main().catch(console.error);
