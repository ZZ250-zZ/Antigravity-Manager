/**
 * 诊断 3: tee() releaseLock 后，另一个分支能否读到所有数据
 */
import { createSession } from 'wreq-js';
import { chromium } from 'playwright';

async function main() {
  // 拿到 qwen cookie 发起真实 SSE 请求（数据量大）
  const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = b.contexts()[0];
  const cookies = await ctx.cookies();
  const ticket = cookies.find(c => c.name === 'tongyi_sso_ticket')?.value;
  b.close();
  if (!ticket) { console.log('no ticket'); process.exit(1); }

  const { randomUUID } = await import('node:crypto');
  const s = await createSession({ browser: 'edge_145', os: 'windows' });

  const body = {
    action: 'next', mode: 'chat', model: 'qwen-plus-latest',
    requestId: randomUUID().replace(/-/g, ''),
    sessionId: '', sessionType: 'text_chat', userAction: 'chat',
    parentMsgId: '', params: { fileUploadBatchId: randomUUID() },
    contents: [{ role: 'user', contentType: 'text', content: '简单说一下春天适合种什么花' }],
  };

  const res = await s.fetch('https://qianwen.biz.aliyun.com/dialog/conversation', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'text/event-stream',
      Cookie: `tongyi_sso_ticket=${ticket}; aliyun_choice=intl`,
      Origin: 'https://chat2.qianwen.com', Referer: 'https://chat2.qianwen.com/',
      'X-Platform': 'pc_tongyi', 'X-Xsrf-Token': randomUUID(),
    },
    body: JSON.stringify(body),
  });

  console.log('status:', res.status);
  const [branch1, branch2] = res.body.tee();

  // 从 branch1 只读一个 chunk（模拟 readSessionId），然后 releaseLock
  const r1 = branch1.getReader();
  const d = new TextDecoder();
  const { value: v1 } = await r1.read();
  const chunk1Text = d.decode(v1);
  console.log('branch1 chunk1:', chunk1Text.slice(0, 80));
  r1.releaseLock();
  console.log('branch1 released');

  // 从 branch2 尝试读所有数据
  console.log('\nreading branch2 (all data)...');
  const r2 = branch2.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let chunks = 0;
  const timer = setTimeout(() => { console.log('\nBRANCH2 HUNG after 10s, read', chunks, 'chunks,', totalBytes, 'bytes'); process.exit(1); }, 10000);
  
  while (true) {
    const { done, value } = await r2.read();
    if (done) break;
    totalBytes += value.length;
    chunks++;
    if (chunks <= 3) console.log(`  chunk ${chunks}: ${decoder.decode(value).slice(0, 60)}`);
  }
  clearTimeout(timer);
  console.log(`branch2: ${chunks} chunks, ${totalBytes} bytes total`);
  
  process.exit(0);
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
