/**
 * 智谱 - 从浏览器页面内发起带完整认证的请求
 * 如果这也失败，说明问题不在 TLS
 */
import { chromium } from 'playwright';

async function main() {
  console.log('=== 智谱 页面内认证请求测试 ===\n');

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();

  // 拦截获取 token + 原始请求
  let token = null, origBody = null;
  page.on('request', req => {
    const auth = req.headers()['authorization'];
    if (auth?.startsWith('Bearer ') && req.url().includes('chatglm.cn')) {
      token = auth.slice(7);
    }
  });

  await page.goto('https://chatglm.cn/main/alltoolsdetail', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(2000);

  if (!token) {
    console.log('❌ 无法获取 token');
    process.exit(1);
  }
  console.log(`Token: ${token.length} chars\n`);

  // Test A: 从页面内发起完整请求（完全模拟浏览器行为）
  console.log('--- Test A: page.evaluate + Authorization + x-device-id ---');
  const resultA = await page.evaluate(async (t) => {
    try {
      const uid = () => crypto.randomUUID().replace(/-/g, '');
      const resp = await fetch('/chatglm/backend-api/assistant/stream', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${t}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'App-Name': 'chatglm',
          'X-App-Platform': 'pc',
          'X-App-Version': '0.0.1',
          'X-Device-Id': uid(),
          'X-Request-Id': uid(),
        },
        body: JSON.stringify({
          assistant_id: '65940acff94777010aa6b796',
          conversation_id: '',
          messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
          meta_data: { channel: '', draft_id: '', if_plus_model: true, input_question_type: 'xxxx', is_test: false, platform: 'pc', quote_log_id: '' },
        }),
      });
      const text = await resp.text();
      return { status: resp.status, ct: resp.headers.get('content-type'), body: text.slice(0, 500) };
    } catch(e) {
      return { error: e.message };
    }
  }, token);
  console.log(`  ${JSON.stringify(resultA).slice(0, 300)}`);

  // Test B: 使用 XMLHttpRequest（不同的请求路径）
  console.log('\n--- Test B: XMLHttpRequest ---');
  const resultB = await page.evaluate(async (t) => {
    return new Promise((resolve) => {
      const uid = () => crypto.randomUUID().replace(/-/g, '');
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/chatglm/backend-api/assistant/stream');
      xhr.setRequestHeader('Authorization', `Bearer ${t}`);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('Accept', 'text/event-stream');
      xhr.setRequestHeader('App-Name', 'chatglm');
      xhr.setRequestHeader('X-App-Platform', 'pc');
      xhr.setRequestHeader('X-App-Version', '0.0.1');
      xhr.setRequestHeader('X-Device-Id', uid());
      xhr.setRequestHeader('X-Request-Id', uid());
      xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText.slice(0, 500) });
      xhr.onerror = () => resolve({ error: 'XHR error' });
      xhr.send(JSON.stringify({
        assistant_id: '65940acff94777010aa6b796',
        conversation_id: '',
        messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
        meta_data: { channel: '', draft_id: '', if_plus_model: true, input_question_type: 'xxxx', is_test: false, platform: 'pc', quote_log_id: '' },
      }));
    });
  }, token);
  console.log(`  ${JSON.stringify(resultB).slice(0, 300)}`);

  // Test C: 使用应用自身的请求方法（如果存在全局 axios/request）
  console.log('\n--- Test C: 检查页面全局状态 ---');
  const globals = await page.evaluate(() => {
    const result = {};
    // 检查 localStorage/sessionStorage 中的 token
    for (const s of [localStorage, sessionStorage]) {
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k.includes('token') || k.includes('auth') || k.includes('user')) {
          result[k] = s.getItem(k)?.slice(0, 50) + '...';
        }
      }
    }
    // 检查全局对象
    result._hasAxios = typeof window.axios !== 'undefined';
    result._hasReact = typeof window.__REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined';
    return result;
  });
  console.log(`  ${JSON.stringify(globals, null, 2)}`);

  await page.close().catch(() => {});
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
