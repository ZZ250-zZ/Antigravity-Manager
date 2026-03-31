/**
 * wreq-js 正确 API 验证智谱
 */
import { fetch as wreqFetch } from 'wreq-js';
import { chromium } from 'playwright';
import { randomUUID } from 'crypto';

function uuid() { return randomUUID().replace(/-/g, ''); }

async function main() {
  console.log('=== wreq-js (edge_145 TLS) 验证智谱 ===\n');

  // 从浏览器获取 token
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  
  let token = null;
  page.on('request', req => {
    if (!token) {
      const auth = req.headers()['authorization'];
      if (auth?.startsWith('Bearer ') && req.url().includes('chatglm.cn')) {
        token = auth.slice(7);
      }
    }
  });
  
  await page.goto('https://chatglm.cn/main/alltoolsdetail', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(2000);
  await page.close().catch(() => {});

  if (!token) {
    console.log('❌ 无法获取 token');
    process.exit(1);
  }
  console.log(`token: ${token.length} 字符\n`);

  // 用 wreq-js 发送请求
  const body = JSON.stringify({
    assistant_id: '65940acff94777010aa6b796',
    conversation_id: '',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好，一句话介绍自己' }] }],
    meta_data: { channel: '', draft_id: '', if_plus_model: true, input_question_type: 'xxxx', is_test: false, platform: 'pc', quote_log_id: '' },
  });

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Referer': 'https://chatglm.cn/main/alltoolsdetail',
    'X-Device-Id': uuid(),
    'X-Request-Id': uuid(),
    'Accept': '*/*',
    'App-Name': 'chatglm',
    'Platform': 'pc',
    'Origin': 'https://chatglm.cn',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0',
    'Version': '0.0.1',
  };

  // 测试不同 profile
  const profiles = ['edge_145', 'chrome_128', 'chrome_120', null]; // null = 无指纹
  
  for (const profile of profiles) {
    const label = profile || 'no-impersonate';
    console.log(`--- ${label} ---`);
    try {
      const opts = {
        method: 'POST',
        headers,
        body,
      };
      if (profile) opts.impersonate = profile;
      
      const resp = await wreqFetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', opts);
      const text = await resp.text();
      const ct = resp.headers.get('content-type') || '';
      
      if (resp.status === 200 && ct.includes('event-stream')) {
        let content = '';
        for (const line of text.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;
          try { const d = JSON.parse(raw); if (d.parts) for (const p of d.parts) if (p.content) content = p.content; } catch(e) {}
        }
        console.log(`  ✅ HTTP 200! 回复: ${content.slice(0, 100)}`);
      } else {
        console.log(`  ❌ HTTP ${resp.status}: ${text.slice(0, 100)}`);
      }
    } catch(e) {
      console.log(`  ❌ 错误: ${e.message}`);
    }
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
