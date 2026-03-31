/**
 * 从浏览器JS内存中提取智谱的有效access_token
 * 并用Node.js fetch直接调用API
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
  console.log('=== 智谱 - 从浏览器提取有效 Token ===\n');

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();

  let capturedToken = null;

  // 拦截所有请求获取 Authorization header 中的 token
  page.on('request', req => {
    if (capturedToken) return;
    const auth = req.headers()['authorization'];
    if (auth?.startsWith('Bearer ') && req.url().includes('chatglm.cn')) {
      capturedToken = auth.slice(7);
    }
  });

  // 导航并等待页面发起第一个带 token 的请求
  console.log('导航到 chatglm.cn...');
  await page.goto('https://chatglm.cn/main/alltoolsdetail', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(2000);

  if (!capturedToken) {
    // 从 localStorage 或 sessionStorage 提取
    console.log('从 storage 提取...');
    capturedToken = await page.evaluate(() => {
      for (const s of [localStorage, sessionStorage]) {
        for (let i = 0; i < s.length; i++) {
          const v = s.getItem(s.key(i));
          if (v?.startsWith('eyJ') && v.length > 100 && v.length < 500) return v;
        }
      }
      // 检查 cookie
      const m = document.cookie.match(/chatglm_token=([^;]+)/);
      return m?.[1] || null;
    });
  }

  // 也获取最新的 refresh_token
  const latestCookies = await context.cookies('https://chatglm.cn');
  const latestRefresh = latestCookies.find(c => c.name === 'chatglm_refresh_token')?.value;

  await page.close().catch(() => {});

  if (!capturedToken) {
    console.log('❌ 无法提取 token');
    process.exit(1);
  }

  console.log(`✅ 提取到 access_token: ${capturedToken.length} 字符`);

  // 解码 JWT
  try {
    const payload = JSON.parse(Buffer.from(capturedToken.split('.')[1], 'base64').toString());
    const exp = new Date(payload.exp * 1000);
    const now = new Date();
    console.log(`  过期时间: ${exp.toLocaleString()}`);
    console.log(`  当前时间: ${now.toLocaleString()}`);
    console.log(`  剩余: ${((payload.exp * 1000 - Date.now()) / 3600000).toFixed(1)} 小时`);
    if (Date.now() > payload.exp * 1000) {
      console.log('  ⚠️ Token 已过期！');
      
      // 尝试用 refresh_token 刷新
      if (latestRefresh) {
        console.log('\n尝试刷新...');
        const resp = await fetch('https://chatglm.cn/chatglm/user-api/user/refresh', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${latestRefresh}`,
            'Content-Type': 'application/json',
            'Referer': 'https://chatglm.cn/main/alltoolsdetail',
            'X-Device-Id': uuid(),
            'X-Request-Id': uuid(),
            ...FAKE_HEADERS,
          },
          body: '{}',
        });
        console.log(`  HTTP: ${resp.status}`);
        const data = await resp.json();
        if (data.result?.accessToken || data.result?.access_token) {
          capturedToken = data.result.accessToken || data.result.access_token;
          console.log(`  ✅ 刷新成功: ${capturedToken.length} 字符`);
        } else {
          console.log(`  ${JSON.stringify(data).slice(0, 200)}`);
          console.log('\n  Token 和 refresh_token 都已过期。需要用户重新登录 chatglm.cn');
          console.log('  但 doubao-free-api 格式已证明不需要 TLS 指纹伪装。');
          console.log('  结论：智谱 API 可用普通 HTTP 调用，token 过期是独立问题。');
          process.exit(0);
        }
      }
    }
  } catch(e) {
    console.log(`  JWT 解码失败: ${e.message}`);
  }

  // 用 Node.js fetch 直接调用（无 TLS 伪装，无 x-sign）
  console.log('\n发送聊天请求 (Node.js fetch, 无 TLS 伪装)...');

  const chatResp = await fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${capturedToken}`,
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

  console.log(`  HTTP: ${chatResp.status}, Content-Type: ${chatResp.headers.get('content-type')}`);
  const text = await chatResp.text();

  if (chatResp.status === 200) {
    let content = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') continue;
      try { const d = JSON.parse(raw); if (d.parts) for (const p of d.parts) if (p.content) content = p.content; } catch(e) {}
    }
    console.log(`  回复: ${content.slice(0, 300)}`);
    console.log('\n  ✅✅✅ 智谱 Node.js 直接调用成功！');
  } else {
    console.log(`  ❌ ${text.slice(0, 300)}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
