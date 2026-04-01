/**
 * 快速诊断: wreq-js 直接请求 Qwen API，排查挂起问题
 */
import { createSession } from 'wreq-js';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

async function getToken() {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const c = b.contexts()[0];
  const cookies = await c.cookies();
  const t = cookies.find(c => c.name === 'tongyi_sso_ticket');
  b.close();
  return t?.value || '';
}

async function main() {
  const ticket = await getToken();
  if (!ticket) { console.log('No ticket found'); process.exit(1); }
  console.log('ticket:', ticket.slice(0, 15) + '...');

  const s = await createSession({ browser: 'edge_145', os: 'windows' });
  console.log('session ok');

  const body = {
    action: 'next', mode: 'chat', model: 'qwen-plus-latest',
    requestId: randomUUID().replace(/-/g, ''),
    sessionId: '', sessionType: 'text_chat', userAction: 'chat',
    parentMsgId: '', params: { fileUploadBatchId: randomUUID() },
    contents: [{ role: 'user', contentType: 'text', content: '你好' }],
  };

  console.log('fetching qianwen.biz...');
  const controller = new AbortController();
  const timer = setTimeout(() => { console.log('TIMEOUT (20s)'); controller.abort(); }, 20000);

  try {
    const r = await s.fetch('https://qianwen.biz.aliyun.com/dialog/conversation', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Cookie: `tongyi_sso_ticket=${ticket}; aliyun_choice=intl`,
        Origin: 'https://chat2.qianwen.com',
        Referer: 'https://chat2.qianwen.com/',
        'X-Platform': 'pc_tongyi',
        'X-Xsrf-Token': randomUUID(),
      },
      body: JSON.stringify(body),
    });
    clearTimeout(timer);
    console.log('status:', r.status);
    console.log('headers:', Object.fromEntries(r.headers.entries()));
    
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let total = '';
    let readCount = 0;
    while (readCount < 5) {
      const { done, value } = await reader.read();
      if (done) { console.log('stream ended'); break; }
      const chunk = decoder.decode(value, { stream: true });
      total += chunk;
      readCount++;
      console.log(`chunk ${readCount}: ${chunk.slice(0, 100)}`);
    }
    await reader.cancel();
    console.log('\ntotal response (first 500):', total.slice(0, 500));
  } catch (e) {
    clearTimeout(timer);
    console.error('ERROR:', e.message);
  }
  process.exit(0);
}

main();
