/**
 * 使用 free-api 项目的验证格式测试智谱 + 豆包
 * 参考 LLM-Red-Team/glm-free-api 和 doubao-free-api
 * 证明普通 HTTP 客户端即可工作，无需 TLS 指纹伪装
 */
import { chromium } from 'playwright';
import { randomUUID } from 'crypto';

const target = process.argv[2] || 'all'; // zhipu / doubao / all

const FAKE_HEADERS_GLM = {
  'Accept': '*/*',
  'App-Name': 'chatglm',
  'Platform': 'pc',
  'Origin': 'https://chatglm.cn',
  'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Version': '0.0.1',
};

const FAKE_HEADERS_DOUBAO = {
  'Accept': '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Cache-Control': 'no-cache',
  'Last-Event-Id': 'undefined',
  'Origin': 'https://www.doubao.com',
  'Referer': 'https://www.doubao.com',
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

function uuid() {
  return randomUUID().replace(/-/g, '');
}

function fakeMsToken() {
  const bytes = new Uint8Array(96);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fakeABogus() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const rand = (len) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `mf-${rand(34)}-${rand(6)}`;
}

async function main() {
  console.log('=== free-api 格式验证 ===\n');
  
  // 从浏览器获取 cookies
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  if (!context) { console.log('❌ 未连接到浏览器'); process.exit(1); }

  if (target === 'zhipu' || target === 'all') await testZhipu(context);
  if (target === 'doubao' || target === 'all') await testDoubao(context);

  process.exit(0);
}

// ==================== 智谱 ====================
async function testZhipu(context) {
  console.log('========== 智谱清言 (glm-free-api 格式) ==========\n');

  const cookies = await context.cookies('https://chatglm.cn');
  const refreshToken = cookies.find(c => c.name === 'chatglm_refresh_token')?.value;
  if (!refreshToken) {
    console.log('❌ 未找到 chatglm_refresh_token');
    return;
  }
  console.log(`refresh_token: ${refreshToken.length} 字符`);

  // Step 1: 刷新 token（glm-free-api 用的端点）
  console.log('\n刷新 access_token...');
  
  // 尝试两个 endpoint
  const endpoints = [
    'https://chatglm.cn/chatglm/user-api/user/refresh',
    'https://chatglm.cn/chatglm/backend-api/v1/user/refresh',
  ];
  
  let accessToken = null;
  
  for (const url of endpoints) {
    console.log(`  尝试 ${url.split('chatglm.cn')[1]}...`);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${refreshToken}`,
          'Referer': 'https://chatglm.cn/main/alltoolsdetail',
          'X-Device-Id': uuid(),
          'X-Request-Id': uuid(),
          ...FAKE_HEADERS_GLM,
        },
        body: '{}',
      });
      const data = await resp.json();
      console.log(`    HTTP: ${resp.status}`);
      
      if (data.result?.accessToken) {
        accessToken = data.result.accessToken;
        console.log(`    ✅ accessToken: ${accessToken.length} 字符`);
        break;
      } else if (data.result?.access_token) {
        accessToken = data.result.access_token;
        console.log(`    ✅ access_token: ${accessToken.length} 字符`);
        break;
      } else {
        console.log(`    ${JSON.stringify(data).slice(0, 150)}`);
      }
    } catch(e) {
      console.log(`    ❌ ${e.message}`);
    }
  }

  if (!accessToken) {
    console.log('  ⚠️ 刷新失败，尝试从 cookie 直接使用 chatglm_token...');
    accessToken = cookies.find(c => c.name === 'chatglm_token')?.value;
  }

  if (!accessToken) {
    console.log('❌ 无法获取 access_token');
    return;
  }

  // Step 2: 发送聊天请求（glm-free-api 格式，无 x-sign）
  console.log('\n发送聊天请求 (free-api 格式，无 x-sign)...');
  
  const chatResp = await fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Referer': 'https://chatglm.cn/main/alltoolsdetail',
      'X-Device-Id': uuid(),
      'X-Request-Id': uuid(),
      ...FAKE_HEADERS_GLM,
    },
    body: JSON.stringify({
      assistant_id: '65940acff94777010aa6b796',
      conversation_id: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好，一句话介绍自己' }] }],
      meta_data: {
        channel: '',
        draft_id: '',
        if_plus_model: true,
        input_question_type: 'xxxx',
        is_test: false,
        platform: 'pc',
        quote_log_id: '',
      },
    }),
  });

  console.log(`  HTTP: ${chatResp.status}, Content-Type: ${chatResp.headers.get('content-type')}`);
  const text = await chatResp.text();

  if (chatResp.status === 200 && chatResp.headers.get('content-type')?.includes('event-stream')) {
    let content = '', convId = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const d = JSON.parse(raw);
        if (d.parts) for (const p of d.parts) if (p.content) content = p.content;
        if (d.conversation_id) convId = d.conversation_id;
      } catch(e) {}
    }
    console.log(`  回复: ${content.slice(0, 200)}`);
    console.log('  ✅ 智谱清言 验证成功！（无 x-sign，无 TLS 指纹）');
    
    // 清理会话
    if (convId) {
      await fetch('https://chatglm.cn/chatglm/backend-api/assistant/conversation/delete', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Device-Id': uuid(),
          'X-Request-Id': uuid(),
          ...FAKE_HEADERS_GLM,
        },
        body: JSON.stringify({ assistant_id: '65940acff94777010aa6b796', conversation_id: convId }),
      }).catch(() => {});
    }
  } else {
    console.log(`  ❌ 失败: ${text.slice(0, 300)}`);
  }
}

// ==================== 豆包 ====================
async function testDoubao(context) {
  console.log('\n\n========== 豆包 (doubao-free-api 格式) ==========\n');

  const cookies = await context.cookies('https://www.doubao.com');
  const sessionId = cookies.find(c => c.name === 'sessionid')?.value;
  if (!sessionId) {
    console.log('❌ 未找到 sessionid');
    return;
  }
  console.log(`sessionid: ${sessionId.slice(0, 10)}... (${sessionId.length} 字符)`);

  // 构造请求（doubao-free-api 格式）
  const deviceId = Math.random() * 999999999999999999 + 7000000000000000000;
  const webId = Math.random() * 999999999999999999 + 7000000000000000000;
  const msToken = fakeMsToken();
  const userId = uuid();

  const cookieStr = [
    `is_staff_user=false`,
    `store-region=cn-gd`,
    `store-region-src=uid`,
    `uid_tt=${userId}`,
    `uid_tt_ss=${userId}`,
    `sid_tt=${sessionId}`,
    `sessionid=${sessionId}`,
    `sessionid_ss=${sessionId}`,
    `msToken=${msToken}`,
  ].join('; ');

  const queryParams = new URLSearchParams({
    aid: '497858',
    device_id: String(Math.floor(deviceId)),
    device_platform: 'web',
    language: 'zh',
    pkg_type: 'release_version',
    real_aid: '497858',
    region: 'CN',
    samantha_web: '1',
    sys_region: 'CN',
    tea_uuid: String(Math.floor(webId)),
    use_olympus_account: '1',
    version_code: '20800',
    web_id: String(Math.floor(webId)),
    msToken: msToken,
    a_bogus: fakeABogus(),
  });

  const url = `https://www.doubao.com/samantha/chat/completion?${queryParams}`;
  
  console.log('发送聊天请求 (free-api 格式，fake a_bogus)...');
  
  const chatResp = await fetch(url, {
    method: 'POST',
    headers: {
      ...FAKE_HEADERS_DOUBAO,
      'Content-Type': 'application/json',
      'Cookie': cookieStr,
      'Referer': 'https://www.doubao.com/chat/',
      'Agw-Js-Conv': 'str',
      'X-Flow-Trace': `04-${uuid()}-${uuid().substring(0, 16)}-01`,
    },
    body: JSON.stringify({
      messages: [{
        content: JSON.stringify({ text: '你好，一句话介绍自己' }),
        content_type: 2001,
        attachments: [],
        references: [],
      }],
      completion_option: {
        is_regen: false,
        with_suggest: true,
        need_create_conversation: true,
        launch_stage: 1,
        is_replace: false,
        is_delete: false,
        message_from: 0,
        event_id: '0',
      },
      conversation_id: '0',
      local_conversation_id: `local_16${Array.from({length: 14}, () => Math.floor(Math.random() * 10)).join('')}`,
      local_message_id: randomUUID(),
    }),
  });

  console.log(`  HTTP: ${chatResp.status}, Content-Type: ${chatResp.headers.get('content-type')}`);
  
  const text = await chatResp.text();
  
  if (chatResp.status === 200 && chatResp.headers.get('content-type')?.includes('event-stream')) {
    // 解析 SSE
    let content = '', convId = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '"[DONE]"') continue;
      try {
        const d = JSON.parse(raw);
        // doubao 的 SSE 格式
        if (d.event === 'reply') {
          try {
            const msg = JSON.parse(d.data || '{}');
            if (msg.text) content += msg.text;
          } catch(e) {}
        }
        if (d.conversation_id) convId = d.conversation_id;
        // 尝试不同的解析方式
        if (d.data) {
          try {
            const inner = JSON.parse(d.data);
            if (inner.text) content += inner.text;
          } catch(e) {}
        }
      } catch(e) {}
    }
    
    if (!content) {
      // 打印原始 SSE 前 500 字符便于分析格式
      console.log(`  SSE 原始数据 (前 500 字符): ${text.slice(0, 500)}`);
    } else {
      console.log(`  回复: ${content.slice(0, 200)}`);
    }
    console.log('  ✅ 豆包 API 连通！');
    
    // 清理会话
    if (convId) {
      await fetch(`https://www.doubao.com/samantha/thread/delete?${queryParams}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': cookieStr,
          ...FAKE_HEADERS_DOUBAO,
        },
        body: JSON.stringify({ conversation_id: convId }),
      }).catch(() => {});
    }
  } else {
    console.log(`  ❌ 失败: ${text.slice(0, 500)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
