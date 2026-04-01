#!/usr/bin/env node
/**
 * 一次性检查并提取所有 Provider 的 Cookie/Token
 * 只连接一次 CDP，最小化连接时间
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { updateToken, getValidTokens } from '../src/utils/token-store.mjs';

const CDP_URL = 'http://127.0.0.1:9222';

const PROVIDERS = {
  kimi: {
    domain: 'https://kimi.moonshot.cn',
    cookieDomains: ['kimi.moonshot.cn', '.kimi.moonshot.cn'],
    tokenExtract: (cookies) => {
      const accessToken = cookies.find(c => c.name === 'access_token');
      const refreshToken = cookies.find(c => c.name === 'refresh_token');
      if (accessToken) return accessToken.value;
      if (refreshToken) return refreshToken.value;
      return null;
    },
  },
  step: {
    domain: 'https://www.stepfun.com',
    cookieDomains: ['www.stepfun.com', '.stepfun.com', 'yuewen.cn', '.yuewen.cn'],
    tokenExtract: (cookies) => {
      // Step 需要完整 Cookie（含 Oasis-Token）
      const oasisToken = cookies.find(c => c.name === 'Oasis-Token');
      if (oasisToken) {
        return cookies
          .filter(c => c.domain.includes('stepfun') || c.domain.includes('yuewen'))
          .map(c => `${c.name}=${c.value}`)
          .join('; ');
      }
      return null;
    },
  },
  metaso: {
    domain: 'https://metaso.cn',
    cookieDomains: ['metaso.cn', '.metaso.cn'],
    tokenExtract: (cookies) => {
      // Metaso 需要完整 Cookie
      const relevant = cookies.filter(c => c.domain.includes('metaso'));
      if (relevant.length === 0) return null;
      return relevant.map(c => `${c.name}=${c.value}`).join('; ');
    },
  },
  doubao: {
    domain: 'https://www.doubao.com',
    cookieDomains: ['www.doubao.com', '.doubao.com'],
    tokenExtract: (cookies) => {
      const sessionId = cookies.find(c => c.name === 'sessionid' || c.name === 'sessionid_ss');
      if (sessionId) return sessionId.value;
      return null;
    },
  },
  spark: {
    domain: 'https://xinghuo.xfyun.cn',
    cookieDomains: ['xinghuo.xfyun.cn', '.xfyun.cn'],
    tokenExtract: (cookies) => {
      const sso = cookies.find(c => c.name === 'ssoSessionId');
      if (sso) return sso.value;
      return null;
    },
  },
  zhipu: {
    domain: 'https://chatglm.cn',
    cookieDomains: ['chatglm.cn', '.chatglm.cn'],
    tokenExtract: (cookies) => {
      const token = cookies.find(c => c.name === 'chatglm_token');
      if (token) return token.value;
      return null;
    },
  },
  qwen: {
    domain: 'https://chat.qwen.ai',
    cookieDomains: ['chat.qwen.ai', '.qwen.ai'],
    tokenExtract: (cookies) => {
      const token = cookies.find(c => c.name === 'token');
      if (token) return token.value;
      return null;
    },
  },
  deepseek: {
    domain: 'https://chat.deepseek.com',
    cookieDomains: ['chat.deepseek.com', '.deepseek.com'],
    tokenExtract: (cookies) => {
      const ds = cookies.find(c => c.name === 'ds_session_token' || c.name === 'userToken');
      if (ds) return ds.value;
      return null;
    },
  },
  momi: {
    domain: 'https://aistudio.xiaomimimo.com',
    cookieDomains: ['xiaomimimo.com', '.xiaomimimo.com'],
    tokenExtract: (cookies) => {
      const relevant = cookies.filter(c => c.domain.includes('xiaomimimo'));
      if (relevant.length === 0) return null;
      return relevant.map(c => `${c.name}=${c.value}`).join('; ');
    },
  },
  yuanbao: {
    domain: 'https://yuanbao.tencent.com',
    cookieDomains: ['yuanbao.tencent.com', '.tencent.com'],
    tokenExtract: (cookies) => {
      const relevant = cookies.filter(c => c.domain.includes('yuanbao') || c.domain.includes('tencent'));
      if (relevant.length === 0) return null;
      return relevant.map(c => `${c.name}=${c.value}`).join('; ');
    },
  },
};

async function main() {
  console.log('连接 CDP...');
  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
  console.log('已连接\n');
  
  const context = browser.contexts()[0];
  const results = {};
  
  try {
    for (const [name, config] of Object.entries(PROVIDERS)) {
      try {
        const cookies = await context.cookies(config.domain);
        const token = config.tokenExtract(cookies);
        const expired = cookies.some(c => c.expires > 0 && c.expires * 1000 < Date.now());
        
        results[name] = {
          hasCookies: cookies.length > 0,
          cookieCount: cookies.length,
          hasToken: !!token,
          tokenPreview: token ? token.slice(0, 40) + '...' : null,
          hasExpiredCookies: expired,
          cookieNames: cookies.map(c => c.name).slice(0, 10),
        };
        
        const status = token ? '✅ 有效' : (cookies.length > 0 ? '⚠️ Cookie存在但Token异常' : '❌ 未登录');
        console.log(`${name}: ${status} (${cookies.length} cookies)`);
        
        if (token) {
          // 保存到本地
          await updateToken(name, token);
        }
      } catch (e) {
        console.log(`${name}: ❌ 错误 - ${e.message}`);
        results[name] = { error: e.message };
      }
    }
    
    // 保存详细结果
    await writeFile(
      'd:\\workspace\\me\\Antigravity-Manager\\cn-providers\\debug\\token-check-results.json', 
      JSON.stringify(results, null, 2), 
      'utf-8'
    );
    console.log('\n详细结果已保存到 debug/token-check-results.json');
    
  } finally {
    browser.close();
  }
  
  // 统计
  const existing = await getValidTokens();
  console.log(`\n本地持久化 token 数量: ${Object.keys(existing).length}`);
}

main().catch(e => console.error('CDP 连接失败:', e.message));
