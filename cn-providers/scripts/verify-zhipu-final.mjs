/**
 * 智谱清言最终验证 - 包含 cookies 和完整 headers
 */
import { chromium } from 'playwright';
import { randomUUID, createHash } from 'crypto';

async function main() {
  console.log('=== 智谱清言最终验证 ===\n');
  
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  if (!context) { console.log('❌ 未连接到浏览器'); process.exit(1); }

  // Step 1: 获取 cookies
  const allCookies = await context.cookies('https://chatglm.cn');
  console.log(`chatglm.cn cookies: ${allCookies.length} 个`);
  for (const c of allCookies) {
    console.log(`  ${c.name}: ${c.value.slice(0, 20)}... (len: ${c.value.length})`);
  }
  
  // 构建 cookie 字符串
  const cookieStr = allCookies.map(c => `${c.name}=${c.value}`).join('; ');

  // Step 2: 用 refresh_token 获取新的 access_token
  const refreshToken = allCookies.find(c => c.name === 'chatglm_refresh_token')?.value;
  if (!refreshToken) {
    console.log('❌ 未找到 refresh_token');
    process.exit(1);
  }

  const deviceId = randomUUID().replace(/-/g, '');

  function makeHeaders(token) {
    const ts = Date.now().toString();
    const nonce = randomUUID().replace(/-/g, '');
    const sign = createHash('md5').update(`${ts}-${nonce}-8a1317a7468aa3ad86e997d08f3f31cb`).digest('hex');
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'App-Name': 'chatglm',
      'X-App-Platform': 'pc',
      'X-App-Version': '0.0.1',
      'X-App-Fr': 'default',
      'X-Lang': 'zh',
      'X-Sign': sign,
      'X-Nonce': nonce,
      'X-Timestamp': ts,
      'X-Device-Id': deviceId,
      'X-Request-Id': randomUUID().replace(/-/g, ''),
      'Origin': 'https://chatglm.cn',
      'Referer': 'https://chatglm.cn/main/alltoolsdetail',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0',
      'Cookie': cookieStr,
    };
  }

  console.log('\n刷新 access_token...');
  const refreshResp = await fetch('https://chatglm.cn/chatglm/user-api/user/refresh', {
    method: 'POST',
    headers: makeHeaders(refreshToken),
    body: '{}',
  });
  const refreshData = await refreshResp.json();
  console.log(`  HTTP: ${refreshResp.status}`);
  
  let accessToken;
  if (refreshData.result?.access_token) {
    accessToken = refreshData.result.access_token;
    console.log(`  ✅ access_token 长度: ${accessToken.length}`);
  } else if (refreshData.result?.accessToken) {
    accessToken = refreshData.result.accessToken;
    console.log(`  ✅ accessToken 长度: ${accessToken.length}`);
  } else {
    console.log(`  刷新结果: ${JSON.stringify(refreshData).slice(0, 200)}`);
    // 回退: 从页面拦截获取
    console.log('  回退: 从页面获取...');
    const page = await context.newPage();
    page.on('request', req => {
      if (!accessToken && req.url().includes('chatglm.cn')) {
        const auth = req.headers()['authorization'];
        if (auth?.startsWith('Bearer ') && auth.length > 50) {
          accessToken = auth.slice(7);
        }
      }
    });
    await page.goto('https://chatglm.cn/main/alltoolsdetail', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);
    await page.close().catch(() => {});
  }

  if (!accessToken) {
    console.log('❌ 无法获取 access_token');
    process.exit(1);
  }

  // Step 3: 发送聊天请求（带 cookies）
  console.log('\n发送聊天请求 (带 cookies)...');
  
  const headers = makeHeaders(accessToken);
  headers['Accept'] = 'text/event-stream';

  const chatResp = await fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      assistant_id: '65940acff94777010aa6b796',
      conversation_id: '',
      project_id: '',
      chat_type: 'user_chat',
      meta_data: {
        cogview: { rm_label_watermark: false },
        is_test: false,
        input_question_type: 'xxxx',
        channel: '',
        draft_id: '',
        chat_mode: 'zero',
        is_networking: false,
        quote_log_id: '',
        platform: 'pc',
      },
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好，一句话介绍自己' }] }],
    }),
  });

  console.log(`  HTTP: ${chatResp.status}, Content-Type: ${chatResp.headers.get('content-type')}`);
  
  const text = await chatResp.text();
  
  if (chatResp.status !== 200) {
    console.log(`  ❌ 错误: ${text.slice(0, 300)}`);
    
    // 尝试不带 cookies
    console.log('\n尝试不带 cookies...');
    const h2 = makeHeaders(accessToken);
    delete h2['Cookie'];
    h2['Accept'] = 'text/event-stream';
    
    const chatResp2 = await fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
      method: 'POST',
      headers: h2,
      body: JSON.stringify({
        assistant_id: '65940acff94777010aa6b796',
        conversation_id: '',
        project_id: '',
        chat_type: 'user_chat',
        meta_data: {
          cogview: { rm_label_watermark: false },
          is_test: false,
          input_question_type: 'xxxx',
          channel: '',
          draft_id: '',
          chat_mode: 'zero',
          is_networking: false,
          quote_log_id: '',
          platform: 'pc',
        },
        messages: [{ role: 'user', content: [{ type: 'text', text: '你好，一句话介绍自己' }] }],
      }),
    });
    
    const text2 = await chatResp2.text();
    console.log(`  HTTP: ${chatResp2.status}, Content-Type: ${chatResp2.headers.get('content-type')}`);
    
    if (chatResp2.status !== 200) {
      console.log(`  ❌ 仍然失败: ${text2.slice(0, 300)}`);
      
      // 比对 headers — 通过 Playwright 页面发起请求
      console.log('\n尝试通过 Playwright 页面发起请求...');
      const page2 = await context.newPage();
      await page2.goto('https://chatglm.cn/main/alltoolsdetail', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page2.waitForTimeout(2000);
      
      const result = await page2.evaluate(async (params) => {
        const { accessToken, ts, nonce, sign, deviceId, requestId } = params;
        try {
          const resp = await fetch('/chatglm/backend-api/assistant/stream', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
              'Authorization': `Bearer ${accessToken}`,
              'App-Name': 'chatglm',
              'X-App-Platform': 'pc',
              'X-App-Version': '0.0.1',
              'X-App-Fr': 'default',
              'X-Lang': 'zh',
              'X-Sign': sign,
              'X-Nonce': nonce,
              'X-Timestamp': ts,
              'X-Device-Id': deviceId,
              'X-Request-Id': requestId,
            },
            body: JSON.stringify({
              assistant_id: '65940acff94777010aa6b796',
              conversation_id: '',
              project_id: '',
              chat_type: 'user_chat',
              meta_data: {
                cogview: { rm_label_watermark: false },
                is_test: false,
                input_question_type: 'xxxx',
                channel: '',
                draft_id: '',
                chat_mode: 'zero',
                is_networking: false,
                quote_log_id: '',
                platform: 'pc',
              },
              messages: [{ role: 'user', content: [{ type: 'text', text: '你好，一句话介绍自己' }] }],
            }),
          });
          
          const text = await resp.text();
          return { status: resp.status, contentType: resp.headers.get('content-type'), body: text.slice(0, 2000) };
        } catch(e) {
          return { error: e.message };
        }
      }, {
        accessToken,
        ts: Date.now().toString(),
        nonce: randomUUID().replace(/-/g, ''),
        sign: createHash('md5').update(`${Date.now()}-${randomUUID().replace(/-/g, '')}-8a1317a7468aa3ad86e997d08f3f31cb`).digest('hex'),
        deviceId,
        requestId: randomUUID().replace(/-/g, ''),
      });
      
      console.log(`  页面内请求结果:`, JSON.stringify(result).slice(0, 500));
      
      if (result.status === 200) {
        // 解析 SSE
        let content = '';
        for (const line of result.body.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const d = JSON.parse(raw);
            if (d.parts) {
              for (const p of d.parts) {
                if (p.content) content = p.content;
              }
            }
          } catch(e) {}
        }
        if (content) {
          console.log(`  ✅ 回复: ${content.slice(0, 200)}`);
        }
      }
      
      await page2.close().catch(() => {});
    } else {
      // 解析 SSE
      parseSSE(text2);
    }
  } else {
    parseSSE(text);
  }

  process.exit(0);
}

function parseSSE(text) {
  let content = '', convId = '';
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const raw = line.slice(6).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const d = JSON.parse(raw);
      if (d.parts) {
        for (const p of d.parts) {
          if (p.content) content = p.content;
        }
      }
      if (d.conversation_id) convId = d.conversation_id;
    } catch(e) {}
  }
  if (content) {
    console.log(`  回复: ${content.slice(0, 200)}`);
    console.log('  ✅ 智谱清言 验证成功！');
  } else {
    console.log(`  ❌ 未解析到内容: ${text.slice(0, 300)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
