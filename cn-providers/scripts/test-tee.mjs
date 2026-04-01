/**
 * 诊断: wreq-js response.body.tee() 是否正常工作
 */
import { createSession } from 'wreq-js';

async function main() {
  const s = await createSession({ browser: 'edge_145', os: 'windows' });
  
  // 用一个会返回 SSE 的简单请求（doubao 用 fake session）
  const res = await s.fetch('https://www.doubao.com/samantha/chat/completion?aid=497858&device_platform=web&language=zh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'sessionid=fake' },
    body: JSON.stringify({ messages: [] }),
  });
  
  console.log('status:', res.status);
  console.log('body type:', res.body?.constructor?.name);
  
  // 测试 tee()
  console.log('\ntesting tee()...');
  const [branch1, branch2] = res.body.tee();
  console.log('tee() ok');
  console.log('branch1:', branch1?.constructor?.name);
  console.log('branch2:', branch2?.constructor?.name);
  
  // 先读 branch1
  console.log('\nreading branch1...');
  const reader1 = branch1.getReader();
  const decoder = new TextDecoder();
  const { done: d1, value: v1 } = await reader1.read();
  console.log('branch1 read:', d1 ? 'done' : decoder.decode(v1).slice(0, 100));
  await reader1.cancel();
  console.log('branch1 cancelled');
  
  // 然后读 branch2
  console.log('\nreading branch2...');
  const reader2 = branch2.getReader();
  const timer = setTimeout(() => { console.log('BRANCH2 HUNG!'); process.exit(1); }, 10000);
  const { done: d2, value: v2 } = await reader2.read();
  clearTimeout(timer);
  console.log('branch2 read:', d2 ? 'done' : decoder.decode(v2).slice(0, 100));
  await reader2.cancel();
  console.log('branch2 ok');
  
  process.exit(0);
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
