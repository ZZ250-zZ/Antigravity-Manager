/**
 * 智谱清言 - 通过浏览器页面刷新token，然后用Node.js直接调用
 */
import { chromium } from 'playwright';
import { randomUUID } from 'crypto';

function uuid() { return randomUUID().replace(/-/g, ''); }

const FAKE_HEADERS = {
  'Accept': '*/*',
  'App-Name': 'chatglm',
  'Platform': 'pc',
  'Origin': 'https://chatglm.cn',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Version': '0.0.1',
};

async function main() {
  console.log('=== 智谱清言 Token 刷新验证 ===\n');
  
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  if (!context) { console.log('❌ 未连接到浏览器'); process.exit(1); }

  // Step 1: 打开页面，让浏览器自动刷新 token
  console.log('Step 1: 导航到 chatglm.cn (触发 token 刷新)...');
  const page = await context.newPage();
  
  // 拦截 refresh 请求
  let refreshResponse = null;
  page.on('response', async resp => {
    if (resp.url().includes('refresh')) {
      console.log(`  [refresh 响应] ${resp.status()} ${resp.url().split('chatglm.cn')[1]?.slice(0, 60)}`);
      if (resp.status() === 200) {
        try {
          refreshResponse = await resp.json();
        } catch(e) {}
      }
    }
  });
  
  await page.goto('https://chatglm.cn/main/alltoolsdetail', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(3000);

  // Step 2: 获取更新后的 cookies
  const cookies = await context.cookies('https://chatglm.cn');
  const refreshToken = cookies.find(c => c.name === 'chatglm_refresh_token')?.value;
  const accessTokenCookie = cookies.find(c => c.name === 'chatglm_token')?.value;
  const expiresCookie = cookies.find(c => c.name === 'chatglm_token_expires')?.value;
  
  console.log(`\n当前 Cookies:`);
  console.log(`  chatglm_refresh_token: ${refreshToken?.length} 字符`);
  console.log(`  chatglm_token: ${accessTokenCookie?.length} 字符`);
  console.log(`  chatglm_token_expires: ${expiresCookie ? decodeURIComponent(expiresCookie) : '无'}`);

  // 如果有 refresh 响应，提取新的 access_token
  let accessToken = null;
  if (refreshResponse?.result?.accessToken) {
    accessToken = refreshResponse.result.accessToken;
    console.log(`\n✅ 从 refresh 响应获得 access_token: ${accessToken.length} 字符`);
  } else {
    // 从 cookie 获取
    accessToken = accessTokenCookie;
    console.log(`\n从 cookie 获取 access_token: ${accessToken?.length} 字符`);
  }

  await page.close().catch(() => {});

  if (!accessToken) {
    console.log('❌ 无法获取 access_token');
    process.exit(1);
  }

  // Step 3: 用 Node.js fetch 直接发送聊天请求（free-api 格式）
  console.log('\nStep 3: 用 Node.js fetch 发送聊天请求 (无 TLS 伪装)...');
  
  const chatResp = await fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Referer': 'https://chatglm.cn/main/alltoolsdetail',
      'X-Device-Id': uuid(),
      'X-Request-Id': uuid(),
      ...FAKE_HEADERS,
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
    console.log(`  回复: ${content.slice(0, 300)}`);
    console.log('\n  ✅✅✅ 智谱清言 Node.js 直接调用成功！无需 TLS 指纹伪装！');
    
    // 清理会话
    if (convId) {
      await fetch('https://chatglm.cn/chatglm/backend-api/assistant/conversation/delete', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Device-Id': uuid(),
          'X-Request-Id': uuid(),
          ...FAKE_HEADERS,
        },
        body: JSON.stringify({ assistant_id: '65940acff94777010aa6b796', conversation_id: convId }),
      }).catch(() => {});
    }
  } else {
    console.log(`  ❌ 失败: ${text.slice(0, 300)}`);
    
    // 尝试使用新的 refresh_token 刷新
    if (refreshToken) {
      console.log('\n尝试手动刷新...');
      const refreshResp = await fetch('https://chatglm.cn/chatglm/user-api/user/refresh', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${refreshToken}`,
          'Content-Type': 'application/json',
          'Referer': 'https://chatglm.cn/main/alltoolsdetail',
          'X-Device-Id': uuid(),
          'X-Request-Id': uuid(),
          ...FAKE_HEADERS,
        },
        body: '{}',
      });
      const refreshData = await refreshResp.json();
      console.log(`  HTTP: ${refreshResp.status}`);
      console.log(`  ${JSON.stringify(refreshData).slice(0, 200)}`);
      
      if (refreshData.result?.accessToken || refreshData.result?.access_token) {
        const newToken = refreshData.result.accessToken || refreshData.result.access_token;
        console.log(`  ✅ 获得新 access_token: ${newToken.length} 字符`);
        
        // 再次尝试聊天
        const chatResp2 = await fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${newToken}`,
            'Content-Type': 'application/json',
            'Referer': 'https://chatglm.cn/main/alltoolsdetail',
            'X-Device-Id': uuid(),
            'X-Request-Id': uuid(),
            ...FAKE_HEADERS,
          },
          body: JSON.stringify({
            assistant_id: '65940acff94777010aa6b796',
            conversation_id: '',
            messages: [{ role: 'user', content: [{ type: 'text', text: '你好，一句话介绍自己' }] }],
            meta_data: { channel: '', draft_id: '', if_plus_model: true, input_question_type: 'xxxx', is_test: false, platform: 'pc', quote_log_id: '' },
          }),
        });
        const text2 = await chatResp2.text();
        console.log(`\n  重试 HTTP: ${chatResp2.status}`);
        if (chatResp2.status === 200) {
          let c = '';
          for (const line of text2.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (!raw || raw === '[DONE]') continue;
            try { const d = JSON.parse(raw); if (d.parts) for (const p of d.parts) if (p.content) c = p.content; } catch(e) {}
          }
          console.log(`  回复: ${c.slice(0, 300)}`);
          console.log('\n  ✅✅✅ 智谱清言 Node.js 直接调用成功！');
        } else {
          console.log(`  ❌ ${text2.slice(0, 200)}`);
        }
      }
    }
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
