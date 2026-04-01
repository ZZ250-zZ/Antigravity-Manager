#!/usr/bin/env node
/**
 * 通过 CDP (Chrome DevTools Protocol) 从已登录的 Edge 浏览器中提取各 Provider 的认证信息。
 *
 * 流程：
 *   1. 连接 CDP (默认 http://127.0.0.1:9222)
 *   2. 使用 Network.getCookies 获取各域名 Cookie
 *   3. 对需要 localStorage 的 Provider，导航到对应页面提取
 *   4. 输出找到的 Token，可选择自动注册到 sidecar
 *
 * 用法：
 *   node scripts/extract-cookies-cdp.mjs                 # 仅提取并显示
 *   node scripts/extract-cookies-cdp.mjs --register       # 提取并注册到 sidecar
 *   node scripts/extract-cookies-cdp.mjs --test           # 提取、注册、发送测试请求
 *
 * 前置条件：Edge 需以 --remote-debugging-port=9222 启动
 */

import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const SIDECAR_BASE = `http://127.0.0.1:${process.env.CN_PROVIDERS_PORT || '8046'}`;
const args = process.argv.slice(2);
const doRegister = args.includes('--register') || args.includes('--test');
const doTest = args.includes('--test');

/**
 * 各 Provider 的 Token 提取配置
 * domain: 用于 Cookie 提取的域名列表
 * cookieKeys: 需要从 Cookie 中找的 key → 最终 token 名
 * localStorageKeys: 需要从 localStorage 中提取的 key → 最终 token 名
 * localStorageUrl: 访问哪个 URL 来提取 localStorage（需要先导航）
 * combineKeys: 多个 cookie 值拼接为一个 token（如 metaso 的 uid-sid）
 */
const PROVIDER_CONFIGS = {
  qwen: {
    domain: ['.aliyun.com', '.qianwen.com'],
    cookieKeys: { tongyi_sso_ticket: 'qwen' },
  },
  kimi: {
    domain: ['.moonshot.cn', '.kimi.com', 'www.kimi.com'],
    // Provider 支持 access_token 和 refresh_token，优先用 kimi-auth (access_token)
    cookieKeys: { 'kimi-auth': 'kimi' },
    localStorageKeys: { refresh_token: 'kimi' },
    localStorageUrl: 'https://www.kimi.com',
  },
  zhipu: {
    domain: ['.chatglm.cn', '.zhipu.ai'],
    // zhipu.mjs 直接用 chatglm_token 作 Bearer 认证
    cookieKeys: { chatglm_token: 'zhipu' },
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
  hailuo: {
    domain: ['.hailuoai.com'],
    localStorageKeys: { _token: 'hailuo' },
    localStorageUrl: 'https://hailuoai.com',
  },
  step: {
    domain: ['.stepchat.cn', '.stepfun.com', 'www.stepfun.com'],
    // Step Connect Protocol 需要完整 Cookie（含 Oasis-Token、Oasis-Webid 等）
    fullCookie: true,
    fullCookieTo: 'step',
    fullCookieDomain: '.stepfun.com',
  },
  spark: {
    domain: ['.xfyun.cn'],
    cookieKeys: { ssoSessionId: 'spark' },
  },
  metaso: {
    domain: ['.metaso.cn'],
    fullCookie: true,
    fullCookieTo: 'metaso',
    fullCookieDomain: '.metaso.cn',
  },
  momi: {
    domain: ['.xiaomimimo.com'],
    fullCookie: true,
    fullCookieTo: 'momi',
    fullCookieDomain: '.xiaomimimo.com',
  },
  yuanbao: {
    domain: ['.tencent.com'],
    fullCookie: true,
    fullCookieTo: 'yuanbao',
    fullCookieDomain: '.yuanbao.tencent.com',
  },
};

// 测试用模型
const TEST_MODELS = {
  qwen: 'qwen-plus',
  kimi: 'kimi',
  zhipu: 'glm-4',
  doubao: 'doubao',
  deepseek: 'deepseek-chat',
  hailuo: 'hailuo',
  step: 'stepchat',
  spark: 'spark',
  metaso: 'metaso',
  yuanbao: 'yuanbao',
  momi: 'momi',
};

// 自然测试问题
const TEST_QUESTIONS = [
  '推荐一部最近好看的科幻电影呗',
  '帮我写一首关于春天的五言绝句',
  '用简单的话解释一下量子纠缠是什么',
  '北京有什么好吃的小吃推荐吗',
  '你觉得猫和狗哪个更适合当宠物',
];

function randomQuestion() {
  return TEST_QUESTIONS[Math.floor(Math.random() * TEST_QUESTIONS.length)];
}

async function main() {
  console.log('=== CDP Cookie/Token 提取器 ===\n');

  // 连接 CDP
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
    console.log(`✅ 已连接 CDP: ${CDP_URL}`);
  } catch (e) {
    console.error(`❌ 无法连接 CDP (${CDP_URL}): ${e.message}`);
    console.log('请确保 Edge 以 --remote-debugging-port=9222 启动');
    process.exit(1);
  }

  const contexts = browser.contexts();
  if (contexts.length === 0) {
    console.error('❌ 没有找到浏览器上下文');
    process.exit(1);
  }

  const context = contexts[0];
  const foundTokens = {};

  console.log(`\n--- 提取 Cookie/Token ---\n`);

  for (const [providerName, config] of Object.entries(PROVIDER_CONFIGS)) {
    console.log(`[${providerName}]`);

    // 从 Cookie 提取
    if (config.cookieKeys) {
      const cookies = await context.cookies();
      for (const [cookieName, tokenName] of Object.entries(config.cookieKeys)) {
        const cookie = cookies.find(
          (c) => c.name === cookieName && config.domain.some((d) => c.domain.includes(d.replace(/^\./, '')))
        );
        if (cookie && cookie.value) {
          foundTokens[tokenName] = cookie.value;
          console.log(`  ✅ ${cookieName} = ${cookie.value.slice(0, 20)}...`);
        } else {
          console.log(`  ⚠ ${cookieName} 未找到（未登录或 Cookie 已过期）`);
        }
      }
    }

    // 拼接多个 Cookie (metaso: uid-sid)
    if (config.combineKeys) {
      const cookies = await context.cookies();
      const parts = {};
      let allFound = true;
      for (const key of Object.keys(config.combineKeys)) {
        const cookie = cookies.find(
          (c) => c.name === key && config.domain.some((d) => c.domain.includes(d.replace(/^\./, '')))
        );
        if (cookie && cookie.value) {
          parts[key] = cookie.value;
        } else {
          allFound = false;
          console.log(`  ⚠ ${key} Cookie 未找到`);
        }
      }
      if (allFound) {
        let combined = config.combineFormat;
        for (const [k, v] of Object.entries(parts)) {
          combined = combined.replace(`{${k}}`, v);
        }
        foundTokens[config.combineTo] = combined;
        console.log(`  ✅ 组合 token = ${combined.slice(0, 30)}...`);
      }
    }

    // 完整 Cookie (yuanbao)
    if (config.fullCookie) {
      const cookies = await context.cookies();
      const domainCookies = cookies.filter((c) =>
        config.domain.some((d) => c.domain.includes(d.replace(/^\./, '')))
      );
      if (domainCookies.length > 0) {
        const fullCookieStr = domainCookies.map((c) => `${c.name}=${c.value}`).join('; ');
        foundTokens[config.fullCookieTo] = fullCookieStr;
        console.log(`  ✅ 完整 Cookie (${domainCookies.length} 项) = ${fullCookieStr.slice(0, 40)}...`);
      } else {
        console.log(`  ⚠ 未找到 ${config.fullCookieDomain} 的 Cookie`);
      }
    }

    // 从 localStorage 提取（需要导航到对应页面）
    if (config.localStorageKeys) {
      try {
        // 查找是否已有对应域名的标签页
        let page = context.pages().find((p) => {
          try {
            return new URL(p.url()).origin === new URL(config.localStorageUrl).origin;
          } catch { return false; }
        });
        let needClose = false;

        if (!page) {
          // 打开新标签页
          page = await context.newPage();
          needClose = true;
          await page.goto(config.localStorageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(2000);
        }

        for (const [lsKey, tokenName] of Object.entries(config.localStorageKeys)) {
          // 如果 Cookie 里已经找到了，跳过 localStorage
          if (foundTokens[tokenName]) {
            console.log(`  ✓ ${tokenName} 已从 Cookie 获取，跳过 localStorage`);
            continue;
          }
          const val = await page.evaluate((key) => localStorage.getItem(key), lsKey);
          if (val) {
            // 处理 JSON 格式的 localStorage 值（如 DeepSeek 的 {"value":"..."}）
            let finalVal = val;
            try {
              const parsed = JSON.parse(val);
              if (parsed && typeof parsed === 'object' && 'value' in parsed) {
                finalVal = parsed.value;
              }
            } catch { /* 非 JSON，直接使用原值 */ }
            foundTokens[tokenName] = finalVal;
            console.log(`  ✅ localStorage.${lsKey} = ${finalVal.slice(0, 20)}...`);
          } else {
            console.log(`  ⚠ localStorage.${lsKey} 未找到（未登录？）`);
          }
        }

        if (needClose) {
          await page.close();
        }
      } catch (e) {
        console.log(`  ⚠ localStorage 提取失败: ${e.message.slice(0, 80)}`);
      }
    }
  }

  // 汇总
  console.log('\n--- 提取结果汇总 ---\n');
  const found = Object.entries(foundTokens);
  if (found.length === 0) {
    console.log('❌ 没有找到任何 Token。请先在 Edge 中登录以下网站：');
    console.log('   - https://chat2.qianwen.com (通义千问)');
    console.log('   - https://www.kimi.com (Kimi)');
    console.log('   - https://chatglm.cn (智谱清言)');
    console.log('   - https://www.doubao.com (豆包)');
    console.log('   - https://chat.deepseek.com (DeepSeek)');
    console.log('   等等...');
    await browser.close();
    process.exit(1);
  }

  for (const [name, token] of found) {
    console.log(`  ${name}: ${token.slice(0, 30)}...`);
  }
  console.log(`\n共找到 ${found.length} 个 Provider 的 Token`);

  // 注册到 sidecar
  if (doRegister) {
    console.log('\n--- 注册 Token 到 Sidecar ---\n');
    for (const [provider, token] of found) {
      try {
        const res = await fetch(`${SIDECAR_BASE}/v1/tokens`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, token }),
        });
        if (res.ok) {
          console.log(`  ✅ ${provider} 注册成功`);
        } else {
          const text = await res.text();
          console.log(`  ❌ ${provider} 注册失败: ${res.status} ${text.slice(0, 100)}`);
        }
      } catch (e) {
        console.log(`  ❌ ${provider} 注册失败: ${e.message}`);
      }
    }
  }

  // 测试
  if (doTest) {
    console.log('\n--- 端到端测试 ---\n');
    for (const [provider] of found) {
      const model = TEST_MODELS[provider];
      if (!model) continue;
      const question = randomQuestion();
      console.log(`[${provider}] model=${model}, 问题: "${question}"`);
      try {
        const res = await fetch(`${SIDECAR_BASE}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: question }],
            stream: true,
          }),
        });
        if (!res.ok) {
          const errText = await res.text();
          console.log(`  ❌ HTTP ${res.status}: ${errText.slice(0, 200)}`);
          continue;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';
        let chunks = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trimStart();
            if (payload === '[DONE]') continue;
            if (!payload) continue;
            try {
              const obj = JSON.parse(payload);
              const delta = obj.choices?.[0]?.delta?.content;
              if (delta) {
                fullText += delta;
                chunks++;
              }
            } catch { /* ignore */ }
          }
        }

        if (fullText) {
          console.log(`  ✅ ${chunks} chunks, 回复: ${fullText.slice(0, 80)}...`);
        } else {
          console.log(`  ⚠ 收到响应但内容为空`);
        }
      } catch (e) {
        console.log(`  ❌ 错误: ${e.message.slice(0, 100)}`);
      }
    }
  }

  // 断开（不关闭浏览器）
  browser.close();
  console.log('\n完成。');
}

main().catch((e) => {
  console.error('脚本异常:', e);
  process.exit(1);
});
