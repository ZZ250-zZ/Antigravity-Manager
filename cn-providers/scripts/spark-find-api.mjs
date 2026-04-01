#!/usr/bin/env node
/**
 * 下载 Spark /desk 页面 HTML，解析所有 JS 文件，搜索聊天 API
 */
import { httpRequest } from '../src/http-client.mjs';
import { getValidTokens } from '../src/utils/token-store.mjs';

async function main() {
  const tokens = await getValidTokens();
  const token = tokens.spark;
  
  // 获取 /desk HTML
  const headers = { Cookie: `ssoSessionId=${token}` };
  const res = await httpRequest('https://xinghuo.xfyun.cn/desk', { method: 'GET', headers });
  const html = await res.text();
  console.log('HTML size:', html.length);
  
  // 提取所有 JS URL
  const jsUrls = new Set();
  const scriptRegex = /src="([^"]*\.js[^"]*)"/g;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    let url = match[1];
    if (!url.startsWith('http')) url = 'https://xinghuo.xfyun.cn' + url;
    jsUrls.add(url);
  }
  
  // 也找内联 webpack chunk 映射
  const chunkRegex = /"(\d+)":"([a-f0-9]+)"/g;
  const chunks = [];
  while ((match = chunkRegex.exec(html)) !== null) {
    chunks.push({ id: match[1], hash: match[2] });
  }
  
  console.log(`\n找到 ${jsUrls.size} 个 JS 文件:`);
  for (const url of jsUrls) {
    console.log(`  ${url}`);
  }
  
  console.log(`\n找到 ${chunks.length} 个 webpack chunk 映射`);
  if (chunks.length > 0) {
    console.log('  前 10 个:', chunks.slice(0, 10).map(c => c.id + ':' + c.hash).join(', '));
  }
  
  // 搜索每个 JS 文件中的聊天相关 API
  const searchPatterns = [
    'send_text', 'send-text', 'sendText', 'chat/send',
    '/u/chat/', '/chat_list/', '/chat-list/', 'chatListId',
    'GtToken', 'gtToken', 'gee_token',
    'text/event-stream', 'fetchEventSource',
    'iflygpt-chat', 'assistant/stream',
  ];
  
  console.log('\n=== 搜索 JS 文件中的聊天 API ===');
  for (const url of jsUrls) {
    try {
      const r = await fetch(url);
      const js = await r.text();
      const found = searchPatterns.filter(p => js.includes(p));
      if (found.length > 0) {
        console.log(`\n${url.split('/').pop()} (${js.length} bytes)`);
        console.log(`  found: ${found.join(', ')}`);
        for (const p of found) {
          const idx = js.indexOf(p);
          console.log(`  ${p}: ...${js.slice(Math.max(0, idx - 60), idx + 100)}...`);
        }
      }
    } catch {}
  }
  
  // 如果有 chunk 映射，搜索聊天相关 chunk
  if (chunks.length > 0) {
    console.log('\n=== 搜索 chunk 文件 ===');
    // 尝试 chunk URL 格式
    const baseUrls = [
      'https://xinghuo.xfyun.cn/vulcan/static/js/',
      'https://xhspdup.xfyun.cn/static/js/',
    ];
    
    // 只搜索前 30 个 chunk
    for (const chunk of chunks.slice(0, 30)) {
      for (const base of baseUrls) {
        const chunkUrl = `${base}${chunk.id}.${chunk.hash}.chunk.js`;
        try {
          const r = await fetch(chunkUrl);
          if (!r.ok) continue;
          const js = await r.text();
          const found = searchPatterns.filter(p => js.includes(p));
          if (found.length > 0) {
            console.log(`\n${chunk.id}.${chunk.hash}.chunk.js (${js.length} bytes)`);
            console.log(`  found: ${found.join(', ')}`);
            for (const p of found) {
              const idx = js.indexOf(p);
              console.log(`  ${p}: ...${js.slice(Math.max(0, idx - 60), idx + 100)}...`);
            }
          }
          break;
        } catch {}
      }
    }
  }
}

main().catch(e => console.error(e.message));
