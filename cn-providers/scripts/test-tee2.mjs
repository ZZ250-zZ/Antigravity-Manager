/**
 * 诊断 2: tee() 后不 cancel，看 branch2 能否读取
 */
import { createSession } from 'wreq-js';

async function main() {
  const s = await createSession({ browser: 'edge_145', os: 'windows' });
  
  const res = await s.fetch('https://www.doubao.com/samantha/chat/completion?aid=497858&device_platform=web&language=zh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'sessionid=fake' },
    body: JSON.stringify({ messages: [] }),
  });
  
  console.log('status:', res.status);
  const [branch1, branch2] = res.body.tee();
  console.log('tee() ok');
  
  // 读 branch1 但不 cancel
  const reader1 = branch1.getReader();
  const decoder = new TextDecoder();
  const { done: d1, value: v1 } = await reader1.read();
  console.log('branch1 read ok:', d1 ? 'done' : 'chunk');
  // 故意不调用 reader1.cancel()
  // 但释放 reader lock 以避免影响 tee
  reader1.releaseLock();
  console.log('reader1 released');
  
  // 读 branch2
  const timer = setTimeout(() => { console.log('BRANCH2 HUNG after 5s'); process.exit(1); }, 5000);
  const reader2 = branch2.getReader();
  const { done: d2, value: v2 } = await reader2.read();
  clearTimeout(timer);
  console.log('branch2 read ok:', d2 ? 'done' : decoder.decode(v2).slice(0, 80));
  reader2.releaseLock();
  
  console.log('SUCCESS - tee() works without cancel');
  process.exit(0);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
