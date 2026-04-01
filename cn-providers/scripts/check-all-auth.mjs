#!/usr/bin/env node
/**
 * 检查所有 Provider 的认证状态
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  console.log('=== 全部 Provider 认证检查 ===\n');
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const cookies = await context.cookies();

  const providers = {
    qwen: {
      domains: ['aliyun.com', 'qianwen.com'],
      cookieKeys: ['tongyi_sso_ticket'],
    },
    kimi: {
      domains: ['moonshot.cn', 'kimi.com'],
      cookieKeys: ['kimi-auth'],
      lsKeys: ['access_token'],
      lsUrl: 'https://www.kimi.com',
    },
    zhipu: {
      domains: ['chatglm.cn'],
      cookieKeys: ['chatglm_token', 'chatglm_refresh_token'],
    },
    doubao: {
      domains: ['doubao.com'],
      cookieKeys: ['sessionid'],
    },
    deepseek: {
      domains: ['deepseek.com'],
      lsKeys: ['userToken'],
      lsUrl: 'https://chat.deepseek.com',
    },
    hailuo: {
      domains: ['hailuoai.com'],
      lsKeys: ['_token'],
      lsUrl: 'https://hailuoai.com',
    },
    step: {
      domains: ['stepfun.com'],
      cookieKeys: ['Oasis-Token'],
    },
    spark: {
      domains: ['xfyun.cn'],
      cookieKeys: ['ssoSessionId'],
    },
    metaso: {
      domains: ['metaso.cn'],
      cookieKeys: ['uid', 'sid'],
    },
    yuanbao: {
      domains: ['yuanbao.tencent.com'],
      cookieKeys: ['uid'],
    },
  };

  const results = {};

  for (const [name, config] of Object.entries(providers)) {
    const found = {};
    
    // Cookie 检查
    if (config.cookieKeys) {
      for (const key of config.cookieKeys) {
        const cookie = cookies.find(c => 
          c.name === key && config.domains.some(d => c.domain.includes(d))
        );
        if (cookie) {
          found[key] = cookie.value.slice(0, 20) + '...';
        }
      }
    }
    
    // localStorage 检查
    if (config.lsKeys) {
      let page = context.pages().find(p => {
        try { return config.lsUrl && new URL(p.url()).origin === new URL(config.lsUrl).origin; }
        catch { return false; }
      });
      let needClose = false;
      if (!page && config.lsUrl) {
        try {
          page = await context.newPage();
          needClose = true;
          await page.goto(config.lsUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
          await page.waitForTimeout(2000);
        } catch {
          if (needClose && page) await page.close().catch(() => {});
          page = null;
        }
      }
      if (page) {
        for (const key of config.lsKeys) {
          try {
            const val = await page.evaluate(k => localStorage.getItem(k), key);
            if (val) {
              let finalVal = val;
              try {
                const parsed = JSON.parse(val);
                if (parsed?.value) finalVal = parsed.value;
              } catch {}
              found[key] = finalVal.slice(0, 20) + '...';
            }
          } catch {}
        }
        if (needClose) await page.close().catch(() => {});
      }
    }

    const status = Object.keys(found).length > 0 ? '✅' : '❌';
    results[name] = { status, found };
    console.log(`${status} ${name.padEnd(12)} ${Object.keys(found).length > 0 ? JSON.stringify(found) : '未登录'}`);
  }

  // 汇总
  const available = Object.entries(results).filter(([, v]) => v.status === '✅').map(([k]) => k);
  const missing = Object.entries(results).filter(([, v]) => v.status === '❌').map(([k]) => k);
  
  console.log(`\n可用 (${available.length}): ${available.join(', ')}`);
  console.log(`未登录 (${missing.length}): ${missing.join(', ')}`);

  browser.close();
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
