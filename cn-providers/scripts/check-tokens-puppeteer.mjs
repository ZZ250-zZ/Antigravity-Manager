#!/usr/bin/env node
/**
 * 使用 puppeteer-core 检查并提取所有 Provider 的 Cookie/Token
 */
import puppeteer from 'puppeteer-core';
import { updateToken, getValidTokens } from '../src/utils/token-store.mjs';

async function main() {
  console.log('连接 CDP...');
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null,
  });
  console.log('已连接\n');
  
  // 获取所有 cookies
  const pages = await browser.pages();
  console.log(`打开的页面: ${pages.length}`);
  
  // 使用第一个页面来获取 cookies（通过 CDPSession）
  const page = pages[0];
  const client = await page.createCDPSession();
  
  // 使用 Network.getAllCookies
  const { cookies: allCookies } = await client.send('Network.getAllCookies');
  console.log(`总共 ${allCookies.length} 个 cookies\n`);
  
  // 提取各 provider 的 token
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
        return cookies.length > 0 ? cookies.map(c => `${c.name}=${c.value}`).join('; ') : null;
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
        return cookies.length > 0 ? cookies.map(c => `${c.name}=${c.value}`).join('; ') : null;
      },
    },
    yuanbao: {
      domains: ['yuanbao.tencent.com'],
      extract: (cookies) => {
        return cookies.length > 0 ? cookies.map(c => `${c.name}=${c.value}`).join('; ') : null;
      },
    },
  };
  
  let updatedCount = 0;
  for (const [name, config] of Object.entries(providers)) {
    const domainCookies = allCookies.filter(c => 
      config.domains.some(d => c.domain.includes(d))
    );
    const token = config.extract(domainCookies);
    
    const status = token ? '✅ 有效' : (domainCookies.length > 0 ? '⚠️ Cookie存在但无Token' : '❌ 未登录');
    console.log(`${name}: ${status} (${domainCookies.length} cookies)`);
    
    if (token) {
      await updateToken(name, token);
      updatedCount++;
    } else if (domainCookies.length > 0) {
      console.log(`  Cookie names: ${domainCookies.map(c => c.name).slice(0, 8).join(', ')}`);
    }
  }
  
  await client.detach();
  browser.disconnect();
  
  console.log(`\n已更新 ${updatedCount} 个 token 到本地存储`);
  const saved = await getValidTokens();
  console.log(`本地已保存 ${Object.keys(saved).length} 个有效 token`);
}

main().catch(e => console.error('Error:', e.message));
