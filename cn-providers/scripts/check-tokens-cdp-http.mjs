#!/usr/bin/env node
/**
 * 使用 CDP HTTP 端点 + 简单 WebSocket 直接获取 cookies
 * 不依赖 Playwright，避免超时问题
 */
import WebSocket from 'ws';
import { updateToken, getValidTokens } from '../src/utils/token-store.mjs';

const CDP_URL = 'http://127.0.0.1:9222';

/** 通过 CDP WebSocket 发送命令并等待结果 */
function cdpCommand(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Date.now() + Math.random();
    const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 10000);
    
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.removeListener('message', handler);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      } catch {}
    };
    
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  // 获取浏览器 WebSocket URL
  const versionRes = await fetch(`${CDP_URL}/json/version`);
  const version = await versionRes.json();
  console.log('Browser:', version.Browser);
  
  // 获取所有页面
  const pagesRes = await fetch(`${CDP_URL}/json`);
  const pages = await pagesRes.json();
  console.log(`Pages: ${pages.length}\n`);
  
  // 连接到浏览器 WebSocket
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS connection timeout')), 5000);
  });
  console.log('WebSocket 已连接\n');
  
  // 获取所有 cookies（需要先连接到一个 page target）
  // Browser-level 连接不支持 Network/Storage 域，需要连接到页面
  ws.close();
  
  // 找一个活跃的页面 target
  const pageTarget = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl);
  if (!pageTarget) {
    console.error('没有可用的页面 target');
    return;
  }
  console.log(`连接到页面: ${pageTarget.title} (${pageTarget.url})`);
  
  const pageWs = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    pageWs.on('open', resolve);
    pageWs.on('error', reject);
    setTimeout(() => reject(new Error('Page WS timeout')), 5000);
  });
  
  // 重新定义 ws 为 pageWs
  const origWs = ws;
  const ws2 = pageWs;
  
  // 使用 Network.getAllCookies 获取所有 cookies
  const cookieResult = await cdpCommand(ws2, 'Network.getAllCookies');
  const allCookies = cookieResult.cookies || [];
  console.log(`总共 ${allCookies.length} 个 cookies\n`);
  
  // 按域名分组提取 token
  const providers = {
    kimi: {
      domains: ['kimi.moonshot.cn'],
      extract: (cookies) => {
        const at = cookies.find(c => c.name === 'access_token');
        const rt = cookies.find(c => c.name === 'refresh_token');
        return at?.value || rt?.value || null;
      },
    },
    step: {
      domains: ['stepfun.com'],
      extract: (cookies) => {
        const oasis = cookies.find(c => c.name === 'Oasis-Token');
        if (!oasis) return null;
        return cookies.map(c => `${c.name}=${c.value}`).join('; ');
      },
    },
    metaso: {
      domains: ['metaso.cn'],
      extract: (cookies) => {
        if (cookies.length === 0) return null;
        return cookies.map(c => `${c.name}=${c.value}`).join('; ');
      },
    },
    doubao: {
      domains: ['doubao.com'],
      extract: (cookies) => {
        const sid = cookies.find(c => c.name === 'sessionid' || c.name === 'sessionid_ss');
        return sid?.value || null;
      },
    },
    spark: {
      domains: ['xfyun.cn'],
      extract: (cookies) => {
        const sso = cookies.find(c => c.name === 'ssoSessionId');
        return sso?.value || null;
      },
    },
    zhipu: {
      domains: ['chatglm.cn'],
      extract: (cookies) => {
        const t = cookies.find(c => c.name === 'chatglm_token');
        return t?.value || null;
      },
    },
    qwen: {
      domains: ['qwen.ai'],
      extract: (cookies) => {
        const t = cookies.find(c => c.name === 'token');
        return t?.value || null;
      },
    },
    deepseek: {
      domains: ['deepseek.com'],
      extract: (cookies) => {
        const ds = cookies.find(c => c.name === 'ds_session_token' || c.name === 'userToken');
        return ds?.value || null;
      },
    },
    momi: {
      domains: ['xiaomimimo.com'],
      extract: (cookies) => {
        if (cookies.length === 0) return null;
        return cookies.map(c => `${c.name}=${c.value}`).join('; ');
      },
    },
    yuanbao: {
      domains: ['yuanbao.tencent.com', 'tencent.com'],
      extract: (cookies) => {
        if (cookies.length === 0) return null;
        return cookies.map(c => `${c.name}=${c.value}`).join('; ');
      },
    },
  };
  
  const results = {};
  for (const [name, config] of Object.entries(providers)) {
    const domainCookies = allCookies.filter(c => 
      config.domains.some(d => c.domain.includes(d))
    );
    const token = config.extract(domainCookies);
    
    const status = token ? '✅ 有效' : (domainCookies.length > 0 ? '⚠️ Cookie存在但无Token' : '❌ 未登录');
    console.log(`${name}: ${status} (${domainCookies.length} cookies)`);
    
    if (token) {
      await updateToken(name, token);
      results[name] = { status: 'ok', preview: token.slice(0, 40) };
    } else {
      results[name] = { status: 'no_token', cookieCount: domainCookies.length };
      if (domainCookies.length > 0) {
        console.log(`  Cookie names: ${domainCookies.map(c => c.name).slice(0, 5).join(', ')}`);
      }
    }
  }
  
  ws2.close();
  
  const saved = await getValidTokens();
  console.log(`\n本地已保存 ${Object.keys(saved).length} 个有效 token`);
}

main().catch(e => console.error('Error:', e.message));
