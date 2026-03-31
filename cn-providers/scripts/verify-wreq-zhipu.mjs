/**
 * 使用 wreq-js (Rust TLS 指纹) 验证智谱 API
 * 这是最终方案的验证
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
  // 动态导入 wreq-js
  let wreq;
  try {
    wreq = await import('wreq-js');
    console.log('✅ wreq-js 加载成功');
    console.log('  可用 impersonate profiles:', Object.keys(wreq).filter(k => k.startsWith('Chrome') || k.startsWith('Edge')).slice(0, 10));
  } catch(e) {
    console.log(`❌ wreq-js 加载失败: ${e.message}`);
    process.exit(1);
  }

  console.log('\n=== wreq-js 验证智谱 API ===\n');

  // 从浏览器获取 token
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  
  let capturedToken = null;
  page.on('request', req => {
    if (!capturedToken) {
      const auth = req.headers()['authorization'];
      if (auth?.startsWith('Bearer ') && req.url().includes('chatglm.cn')) {
        capturedToken = auth.slice(7);
      }
    }
  });
  
  await page.goto('https://chatglm.cn/main/alltoolsdetail', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(2000);
  await page.close().catch(() => {});

  if (!capturedToken) {
    console.log('❌ 无法获取 token');
    process.exit(1);
  }
  console.log(`access_token: ${capturedToken.length} 字符`);

  // 使用 wreq-js 发送请求（Chrome TLS 指纹）
  console.log('\n使用 wreq-js (Chrome TLS profile) 发送请求...');
  
  try {
    // wreq-js fetch API
    const wreqFetch = wreq.fetch || wreq.default?.fetch;
    
    if (!wreqFetch) {
      // 列出所有可用的导出
      console.log('wreq-js exports:', Object.keys(wreq));
      console.log('wreq.default:', wreq.default ? Object.keys(wreq.default) : 'none');
      
      // 尝试通过 Client 创建
      const Client = wreq.Client || wreq.default?.Client || wreq.WreqClient;
      if (Client) {
        console.log('使用 Client API...');
        const client = new Client({ impersonate: 'chrome' });
        const resp = await client.fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
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
        console.log(`  HTTP: ${resp.status}`);
        const text = await resp.text();
        handleResponse(resp.status, resp.headers, text);
      } else {
        console.log('尝试默认 fetch...');
        const resp = await wreq.default('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
          method: 'POST',
          impersonate: 'chrome',
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
        console.log(`  HTTP: ${resp.status}`);
        const text = await resp.text();
        handleResponse(resp.status, resp.headers, text);
      }
    } else {
      const resp = await wreqFetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
        method: 'POST',
        impersonate: 'chrome',
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
      console.log(`  HTTP: ${resp.status}`);
      const text = await resp.text();
      handleResponse(resp.status, resp.headers, text);
    }
  } catch(e) {
    console.log(`  ❌ wreq-js 请求失败: ${e.message}`);
    console.log(`  ${e.stack}`);
  }

  process.exit(0);
}

function handleResponse(status, headers, text) {
  const ct = headers.get?.('content-type') || headers['content-type'] || '';
  console.log(`  Content-Type: ${ct}`);
  
  if (status === 200 && ct.includes('event-stream')) {
    let content = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') continue;
      try { const d = JSON.parse(raw); if (d.parts) for (const p of d.parts) if (p.content) content = p.content; } catch(e) {}
    }
    console.log(`  回复: ${content.slice(0, 300)}`);
    console.log('\n  ✅✅✅ wreq-js + Chrome TLS 指纹 验证成功！');
  } else {
    console.log(`  ❌ 状态: ${status}`);
    console.log(`  ${text.slice(0, 300)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
