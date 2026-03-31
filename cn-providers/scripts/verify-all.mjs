/**
 * 中国 AI 服务 Web API 协议验证脚本
 * 
 * 使用 CDP 连接已运行的 Edge 浏览器，提取各服务的登录凭证并验证 API。
 * 
 * 前置条件:
 *   1. 关闭所有 Edge
 *   2. 运行: & "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222
 *   3. 在 Edge 中确认已登录: tongyi.aliyun.com, kimi.moonshot.cn, chatglm.cn, www.doubao.com
 *   4. 运行: node scripts/verify-all.mjs --cdp
 * 
 * 也支持独立运行单个 provider:
 *   node scripts/verify-all.mjs --cdp --only=kimi
 */
import { chromium } from 'playwright';
import http2 from 'http2';
import { randomUUID, createHash } from 'crypto';
import path from 'path';
import os from 'os';

const args = process.argv.slice(2);
const useCdp = args.includes('--cdp');
const onlyProvider = args.find(a => a.startsWith('--only='))?.split('=')[1];

const EDGE_USER_DATA_DIR = path.join(
  os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'
);

// ==================== 通用工具 ====================

function uuid(withDash = true) {
  const id = randomUUID();
  return withDash ? id : id.replace(/-/g, '');
}

function waitForInput(prompt) {
  console.log(prompt);
  return new Promise(resolve => process.stdin.once('data', resolve));
}

// ==================== Qwen Provider ====================

async function verifyQwen(cookies) {
  console.log('\n========== Qwen (通义千问) ==========\n');

  const ticketNames = ['tongyi_sso_ticket', 'login_aliyunid_ticket', 'login_tongyi_ticket'];
  let ticketCookie = null;
  for (const name of ticketNames) {
    ticketCookie = cookies.find(c => c.name === name);
    if (ticketCookie) break;
  }

  if (!ticketCookie) {
    console.log('❌ 未找到 Qwen ticket Cookie (tongyi_sso_ticket / login_aliyunid_ticket)');
    console.log('   请先登录 https://tongyi.aliyun.com/qianwen');
    return { provider: 'qwen', success: false, error: 'No ticket cookie' };
  }

  console.log(`✅ 找到 ticket: ${ticketCookie.name} (长度: ${ticketCookie.value.length})`);

  const cookieStr = [
    `${ticketCookie.name}=${ticketCookie.value}`,
    'aliyun_choice=intl',
    '_samesite_flag_=true',
    `t=${uuid(false)}`,
  ].join('; ');

  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://tongyi.aliyun.com',
    'Referer': 'https://tongyi.aliyun.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'X-Platform': 'pc_tongyi',
    'X-Xsrf-Token': '48b9ee49-a184-45e2-9f67-fa87213edcdc',
    'Sec-Ch-Ua': '"Chromium";v="122"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
  };

  // Test: 发送聊天 (HTTP/2 SSE)
  console.log('发送聊天请求 (HTTP/2 SSE)...');
  try {
    const chatBody = {
      mode: 'chat', model: '', action: 'next', userAction: 'chat',
      requestId: uuid(false), sessionId: '', sessionType: 'text_chat',
      parentMsgId: '', params: { fileUploadBatchId: uuid() },
      contents: [{ role: 'user', contentType: 'text', content: '你好，一句话介绍自己' }],
    };

    const result = await http2Post('https://qianwen.biz.aliyun.com', '/dialog/conversation', chatBody, {
      'Content-Type': 'application/json', 'Cookie': cookieStr, ...headers, 'Accept': 'text/event-stream',
    });

    console.log(`  HTTP: ${result.status}, 事件数: ${result.events.length}`);
    
    let content = '', sessionId = '';
    for (const evt of result.events) {
      if (!evt.data || evt.data === '[DONE]') continue;
      try {
        const p = JSON.parse(evt.data);
        if (p.sessionId) sessionId = p.sessionId;
        if (p.contents) for (const c of p.contents) if (c.content) content = c.content;
      } catch(e) {}
    }
    
    if (content) {
      console.log(`  回复: ${content.slice(0, 200)}`);
      console.log('  ✅ Qwen 验证成功！');
      // 清理会话
      if (sessionId) {
        await fetch('https://qianwen.biz.aliyun.com/dialog/session/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookieStr, ...headers },
          body: JSON.stringify({ sessionId }),
        }).catch(() => {});
      }
      return { provider: 'qwen', success: true, content, token: ticketCookie.value, tokenName: ticketCookie.name };
    } else {
      console.log('  ❌ 未收到有效回复');
      console.log(`  原始: ${result.rawBody.slice(0, 300)}`);
      return { provider: 'qwen', success: false, error: 'No content in response' };
    }
  } catch (e) {
    console.log(`  ❌ 请求失败: ${e.message}`);
    return { provider: 'qwen', success: false, error: e.message };
  }
}

// ==================== Kimi Provider ====================

async function verifyKimi(cookies) {
  console.log('\n========== Kimi (月之暗面) ==========\n');

  // Kimi 的 refresh_token 存在 localStorage 中，需要通过页面获取
  // 但我们也可以检查 cookies 中是否有有效 session
  // 先尝试通过 Playwright 页面获取 localStorage
  console.log('Kimi 使用 localStorage 中的 refresh_token');
  console.log('将通过 CDP 从页面获取...');
  
  return { provider: 'kimi', success: false, error: 'Need page access for localStorage', needPage: true };
}

async function verifyKimiWithPage(page) {
  console.log('\n========== Kimi (月之暗面) - 页面模式 ==========\n');
  
  try {
    await page.goto('https://kimi.moonshot.cn', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);
    
    const refreshToken = await page.evaluate(() => {
      return localStorage.getItem('refresh_token');
    });

    if (!refreshToken) {
      console.log('❌ 未找到 refresh_token，请先登录 kimi.moonshot.cn');
      return { provider: 'kimi', success: false, error: 'No refresh_token' };
    }

    console.log(`✅ 找到 refresh_token (长度: ${refreshToken.length})`);

    const headers = {
      'Accept': '*/*',
      'Origin': 'https://kimi.moonshot.cn',
      'Referer': 'https://kimi.moonshot.cn/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Sec-Ch-Ua': '"Google Chrome";v="123"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'X-Msh-Platform': 'web',
    };

    // Step 1: 刷新 token 获取 access_token
    console.log('刷新 access_token...');
    const refreshResp = await fetch('https://kimi.moonshot.cn/api/auth/token/refresh', {
      method: 'GET',
      headers: { ...headers, Authorization: `Bearer ${refreshToken}` },
    });
    const refreshData = await refreshResp.json();
    
    if (!refreshData.access_token) {
      console.log(`  ❌ 刷新失败: ${JSON.stringify(refreshData).slice(0, 200)}`);
      return { provider: 'kimi', success: false, error: 'Token refresh failed' };
    }
    
    const accessToken = refreshData.access_token;
    const newRefreshToken = refreshData.refresh_token;
    console.log(`  ✅ access_token 获取成功 (长度: ${accessToken.length})`);

    // Step 2: 获取用户信息
    const userResp = await fetch('https://kimi.moonshot.cn/api/user', {
      headers: { ...headers, Authorization: `Bearer ${accessToken}` },
    });
    const userData = await userResp.json();
    const userId = userData.id || `7${uuid(false).slice(0, 18)}`;
    console.log(`  用户ID: ${userId}`);

    // Step 3: 创建会话
    console.log('创建会话...');
    const convResp = await fetch('https://kimi.moonshot.cn/api/chat', {
      method: 'POST',
      headers: { ...headers, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Traffic-Id': userId },
      body: JSON.stringify({ born_from: '', is_example: false, kimiplus_id: 'kimi', name: '验证测试' }),
    });
    const convData = await convResp.json();
    const convId = convData.id;
    console.log(`  会话ID: ${convId}`);

    // Step 4: 发送聊天 (SSE)
    console.log('发送聊天请求 (SSE)...');
    const chatResp = await fetch(`https://kimi.moonshot.cn/api/chat/${convId}/completion/stream`, {
      method: 'POST',
      headers: { ...headers, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Traffic-Id': userId },
      body: JSON.stringify({
        kimiplus_id: 'kimi',
        messages: [{ role: 'user', content: '你好，一句话介绍自己' }],
        refs: [],
        use_search: false,
      }),
    });

    const text = await chatResp.text();
    console.log(`  HTTP: ${chatResp.status}`);
    
    // 解析 SSE
    let content = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.event === 'cmpl' && parsed.text) {
          content += parsed.text;
        }
      } catch(e) {}
    }

    if (content) {
      console.log(`  回复: ${content.slice(0, 200)}`);
      console.log('  ✅ Kimi 验证成功！');
      // 清理会话
      await fetch(`https://kimi.moonshot.cn/api/chat/${convId}`, {
        method: 'DELETE',
        headers: { ...headers, Authorization: `Bearer ${accessToken}`, 'X-Traffic-Id': userId },
      }).catch(() => {});
      return { provider: 'kimi', success: true, content, token: refreshToken };
    } else {
      console.log(`  ❌ 未解析到内容`);
      console.log(`  原始: ${text.slice(0, 500)}`);
      return { provider: 'kimi', success: false, error: 'No content parsed' };
    }
  } catch (e) {
    console.log(`  ❌ 错误: ${e.message}`);
    return { provider: 'kimi', success: false, error: e.message };
  }
}

// ==================== 智谱清言 (ChatGLM) Provider ====================

async function verifyZhipu(cookies) {
  console.log('\n========== 智谱清言 (ChatGLM) ==========\n');

  const refreshCookie = cookies.find(c => c.name === 'chatglm_refresh_token');
  if (!refreshCookie) {
    console.log('❌ 未找到 chatglm_refresh_token Cookie');
    console.log('   请先登录 https://chatglm.cn');
    return { provider: 'zhipu', success: false, error: 'No refresh token cookie' };
  }

  const refreshToken = refreshCookie.value;
  console.log(`✅ 找到 chatglm_refresh_token (长度: ${refreshToken.length})`);

  const headers = {
    'Accept': '*/*',
    'App-Name': 'chatglm',
    'Platform': 'pc',
    'Origin': 'https://chatglm.cn',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Sec-Ch-Ua': '"Chromium";v="122"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Version': '0.0.1',
  };

  // Step 1: 刷新 token
  console.log('刷新 access_token...');
  try {
    const refreshResp = await fetch('https://chatglm.cn/chatglm/backend-api/v1/user/refresh', {
      method: 'POST',
      headers: {
        ...headers,
        Authorization: `Bearer ${refreshToken}`,
        'Content-Type': 'application/json',
        Referer: 'https://chatglm.cn/main/alltoolsdetail',
        'X-Device-Id': uuid(false),
        'X-Request-Id': uuid(false),
      },
      body: '{}',
    });
    const refreshData = await refreshResp.json();

    if (!refreshData.result?.accessToken) {
      console.log(`  ❌ 刷新失败: ${JSON.stringify(refreshData).slice(0, 200)}`);
      return { provider: 'zhipu', success: false, error: 'Token refresh failed' };
    }

    const accessToken = refreshData.result.accessToken;
    console.log(`  ✅ access_token 获取成功`);

    // Step 2: 发送聊天 (SSE)
    const DEFAULT_ASSISTANT_ID = '65940acff94777010aa6b796';
    
    console.log('发送聊天请求 (SSE)...');
    const chatResp = await fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
      method: 'POST',
      headers: {
        ...headers,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Referer: 'https://chatglm.cn/main/alltoolsdetail',
        'X-Device-Id': uuid(false),
        'X-Request-Id': uuid(false),
      },
      body: JSON.stringify({
        assistant_id: DEFAULT_ASSISTANT_ID,
        conversation_id: '',
        messages: [{ role: 'user', content: [{ type: 'text', text: '你好，一句话介绍自己' }] }],
        meta_data: {
          channel: '', draft_id: '', if_plus_model: true,
          input_question_type: 'xxxx', is_test: false, platform: 'pc', quote_log_id: '',
        },
      }),
    });

    const text = await chatResp.text();
    console.log(`  HTTP: ${chatResp.status}`);

    // 解析 SSE
    let content = '';
    let convId = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      try {
        const parsed = JSON.parse(data);
        if (parsed.parts) {
          for (const part of parsed.parts) {
            if (part.content) content += part.content;
          }
        }
        if (parsed.conversation_id) convId = parsed.conversation_id;
      } catch(e) {}
    }

    if (content) {
      console.log(`  回复: ${content.slice(0, 200)}`);
      console.log('  ✅ 智谱清言 验证成功！');
      // 清理会话
      if (convId) {
        await fetch('https://chatglm.cn/chatglm/backend-api/assistant/conversation/delete', {
          method: 'POST',
          headers: { ...headers, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json',
            'X-Device-Id': uuid(false), 'X-Request-Id': uuid(false) },
          body: JSON.stringify({ assistant_id: DEFAULT_ASSISTANT_ID, conversation_id: convId }),
        }).catch(() => {});
      }
      return { provider: 'zhipu', success: true, content, token: refreshToken };
    } else {
      console.log(`  ❌ 未解析到内容`);
      console.log(`  原始: ${text.slice(0, 500)}`);
      return { provider: 'zhipu', success: false, error: 'No content' };
    }
  } catch (e) {
    console.log(`  ❌ 错误: ${e.message}`);
    return { provider: 'zhipu', success: false, error: e.message };
  }
}

// ==================== 豆包 (Doubao) Provider ====================

async function verifyDoubao(cookies) {
  console.log('\n========== 豆包 (Doubao) ==========\n');

  const sessionCookie = cookies.find(c => c.name === 'sessionid' && c.domain.includes('doubao'));
  // 也检查 sessionid_ss
  const sessionSsCookie = cookies.find(c => c.name === 'sessionid_ss' && c.domain.includes('doubao'));
  const token = sessionCookie?.value || sessionSsCookie?.value;
  
  if (!token) {
    console.log('❌ 未找到 doubao sessionid Cookie');
    console.log('   请先登录 https://www.doubao.com');
    console.log('   相关 cookies:');
    cookies.filter(c => c.domain.includes('doubao')).forEach(c => 
      console.log(`   - ${c.name} (domain: ${c.domain})`));
    return { provider: 'doubao', success: false, error: 'No sessionid' };
  }

  console.log(`✅ 找到 sessionid (长度: ${token.length})`);

  const DEVICE_ID = Math.floor(Math.random() * 999999999999999999 + 7000000000000000000);
  const WEB_ID = Math.floor(Math.random() * 999999999999999999 + 7000000000000000000);
  const USER_ID = uuid(false);
  
  // 生成伪 msToken
  const msTokenBytes = new Uint8Array(96);
  for (let i = 0; i < 96; i++) msTokenBytes[i] = Math.floor(Math.random() * 256);
  const msToken = Buffer.from(msTokenBytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  // 生成伪 a_bogus
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const randStr = (len) => Array.from({length: len}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  const aBogus = `mf-${randStr(34)}-${randStr(6)}`;

  const cookieStr = [
    `is_staff_user=false`,
    `store-region=cn-gd`,
    `store-region-src=uid`,
    `uid_tt=${USER_ID}`,
    `sid_tt=${token}`,
    `sessionid=${token}`,
    `sessionid_ss=${token}`,
    `msToken=${msToken}`,
  ].join('; ');

  const headers = {
    'Accept': '*/*',
    'Origin': 'https://www.doubao.com',
    'Referer': 'https://www.doubao.com/chat/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Agw-js-conv': 'str',
    'Cookie': cookieStr,
    'Content-Type': 'application/json',
    'X-Flow-Trace': `04-${uuid()}-${uuid().substring(0, 16)}-01`,
  };

  const DEFAULT_AID = '497858';
  const params = new URLSearchParams({
    aid: DEFAULT_AID, device_id: String(DEVICE_ID), device_platform: 'web',
    language: 'zh', pkg_type: 'release_version', real_aid: DEFAULT_AID,
    region: 'CN', samantha_web: '1', sys_region: 'CN',
    tea_uuid: String(WEB_ID), use_olympus_account: '1', version_code: '20800',
    web_id: String(WEB_ID), msToken: msToken, a_bogus: aBogus,
  });

  console.log('发送聊天请求 (SSE)...');
  try {
    const url = `https://www.doubao.com/samantha/chat/completion?${params.toString()}`;
    const chatResp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: [{ content: '你好，一句话介绍自己', content_type: 'text' }],
        completion_option: {
          is_regen: false, with_suggest: true, need_create_conversation: true,
          launch_stage: 1, is_replace: false, is_delete: false, message_from: 0, event_id: '0',
        },
        conversation_id: '0',
        local_conversation_id: `local_16${randStr(14)}`,
        local_message_id: uuid(),
      }),
    });

    const text = await chatResp.text();
    console.log(`  HTTP: ${chatResp.status}`);
    console.log(`  Content-Type: ${chatResp.headers.get('content-type')}`);

    // 豆包使用自定义 SSE 格式（event_type 字段）
    let content = '';
    let convId = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      try {
        const parsed = JSON.parse(data);
        // event_type 2001 = 文本块, 2003 = 完成
        if (parsed.event_type === 2001 && parsed.data?.text) {
          content += parsed.data.text;
        }
        // 也尝试其他格式
        if (parsed.text) content += parsed.text;
        if (parsed.conversation_id) convId = parsed.conversation_id;
      } catch(e) {}
    }

    if (content) {
      console.log(`  回复: ${content.slice(0, 200)}`);
      console.log('  ✅ 豆包 验证成功！');
      // 清理会话
      if (convId) {
        const deleteUrl = `https://www.doubao.com/samantha/thread/delete?${params.toString()}`;
        await fetch(deleteUrl, {
          method: 'POST', headers,
          body: JSON.stringify({ conversation_id: convId }),
        }).catch(() => {});
      }
      return { provider: 'doubao', success: true, content, token };
    } else {
      console.log(`  ❌ 未解析到内容`);
      console.log(`  原始响应 (前500字符): ${text.slice(0, 500)}`);
      return { provider: 'doubao', success: false, error: 'No content', rawBody: text.slice(0, 1000) };
    }
  } catch (e) {
    console.log(`  ❌ 错误: ${e.message}`);
    return { provider: 'doubao', success: false, error: e.message };
  }
}

// ==================== HTTP/2 工具 ====================

function http2Post(authority, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const session = http2.connect(authority);
    session.on('error', (err) => reject(new Error(`HTTP/2 连接失败: ${err.message}`)));

    const req = session.request({ ':method': 'POST', ':path': urlPath, ...headers });
    req.setTimeout(60000);
    req.write(JSON.stringify(body));
    req.end();

    let rawBody = '', status = 0, contentType = '';
    const events = [];

    req.on('response', (h) => { status = h[':status']; contentType = h['content-type'] || ''; });
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      rawBody += chunk;
      for (const line of chunk.split('\n')) {
        const t = line.trim();
        if (t.startsWith('data:')) events.push({ data: t.slice(5).trim() });
      }
    });
    req.on('end', () => { session.close(); resolve({ status, contentType, events, rawBody }); });
    req.on('error', (e) => { session.close(); reject(e); });
    setTimeout(() => { req.close(); session.close(); resolve({ status, contentType, events, rawBody }); }, 60000);
  });
}

// ==================== 主流程 ====================

async function main() {
  console.log('=== 中国 AI 服务 Web API 协议验证 ===\n');

  let context, browser;

  if (useCdp) {
    console.log('连接到 Edge (CDP, port 9222)...\n');
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    context = browser.contexts()[0];
    if (!context) {
      console.log('❌ 未找到浏览器上下文');
      return;
    }
  } else {
    console.log('启动 Edge (用户 Profile)...\n');
    context = await chromium.launchPersistentContext(
      path.join(EDGE_USER_DATA_DIR, 'Default'),
      { channel: 'msedge', headless: false, args: ['--disable-blink-features=AutomationControlled'], viewport: { width: 1280, height: 800 } }
    );
  }

  // 获取所有 cookies
  const cookies = await context.cookies();
  console.log(`共获取 ${cookies.length} 个 Cookies\n`);

  const results = [];
  const providers = onlyProvider ? [onlyProvider] : ['qwen', 'kimi', 'zhipu', 'doubao'];

  for (const provider of providers) {
    switch (provider) {
      case 'qwen':
        results.push(await verifyQwen(cookies));
        break;
      case 'kimi': {
        // Kimi 需要通过页面获取 localStorage
        const page = await context.newPage();
        results.push(await verifyKimiWithPage(page));
        await page.close().catch(() => {});
        break;
      }
      case 'zhipu':
        results.push(await verifyZhipu(cookies));
        break;
      case 'doubao':
        results.push(await verifyDoubao(cookies));
        break;
    }
  }

  // 汇总结果
  console.log('\n\n========== 验证结果汇总 ==========\n');
  console.log('| Provider | 状态 | 说明 |');
  console.log('|----------|------|------|');
  for (const r of results) {
    const status = r.success ? '✅ 成功' : '❌ 失败';
    const detail = r.success ? `回复: ${(r.content || '').slice(0, 50)}...` : (r.error || '');
    console.log(`| ${r.provider.padEnd(8)} | ${status} | ${detail} |`);
  }

  // 关闭浏览器
  if (browser) await browser.close().catch(() => {});
  else await context.close().catch(() => {});
}

main().catch(console.error);
