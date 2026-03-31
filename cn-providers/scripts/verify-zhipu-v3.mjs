/**
 * 智谱清言验证 v3 - 通过浏览器页面上下文发起请求
 * 利用页面自身的 token 管理和 cookie 机制
 */
import { chromium } from 'playwright';

async function main() {
  console.log('=== 智谱清言验证 v3 ===\n');
  
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  if (!context) { console.log('❌ 未连接到浏览器'); process.exit(1); }

  const page = await context.newPage();
  
  // 拦截 stream 请求和响应
  let streamReqBody = null;
  let streamReqHeaders = null;
  let streamRespStatus = null;
  let streamRespBody = '';
  
  page.on('request', req => {
    if (req.url().includes('assistant/stream') && req.method() === 'POST') {
      streamReqHeaders = req.headers();
      streamReqBody = req.postData();
      console.log(`[拦截请求] ${req.url().slice(0, 100)}`);
    }
  });
  
  page.on('response', async resp => {
    if (resp.url().includes('assistant/stream')) {
      streamRespStatus = resp.status();
      try {
        streamRespBody = await resp.text();
      } catch(e) {
        console.log(`[响应体读取失败] ${e.message}`);
      }
      console.log(`[拦截响应] ${resp.status()} ${resp.headers()['content-type']}`);
    }
  });

  // 导航到智谱
  console.log('导航到 chatglm.cn...');
  await page.goto('https://chatglm.cn/main/alltoolsdetail', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);

  // 检查当前 cookies
  const cookies = await context.cookies('https://chatglm.cn');
  const tokenCookie = cookies.find(c => c.name === 'chatglm_token');
  const refreshCookie = cookies.find(c => c.name === 'chatglm_refresh_token');
  const expireCookie = cookies.find(c => c.name === 'chatglm_token_expires');
  
  console.log(`chatglm_token: ${tokenCookie ? `${tokenCookie.value.length} 字符` : '无'}`);
  console.log(`chatglm_token_expires: ${expireCookie ? decodeURIComponent(expireCookie.value) : '无'}`);
  console.log(`chatglm_refresh_token: ${refreshCookie ? `${refreshCookie.value.length} 字符` : '无'}`);

  // 查找输入框
  const textarea = await page.$('textarea');
  if (!textarea) {
    console.log('❌ 未找到 textarea');
    await page.close().catch(() => {});
    process.exit(1);
  }
  
  const visible = await textarea.isVisible();
  console.log(`\ntextarea 可见: ${visible}`);

  // 通过 UI 发送消息
  console.log('输入消息并发送...');
  await textarea.click();
  await page.waitForTimeout(300);
  await textarea.fill('你好，一句话介绍自己');
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');

  // 等待响应
  console.log('等待 API 响应...');
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    if (streamRespBody) break;
  }

  if (streamRespStatus === 200 && streamRespBody) {
    console.log(`\n✅ API 响应 200`);
    
    // 解析 SSE
    let content = '', convId = '';
    for (const line of streamRespBody.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const d = JSON.parse(raw);
        if (d.parts) for (const p of d.parts) if (p.content) content = p.content;
        if (d.conversation_id) convId = d.conversation_id;
      } catch(e) {}
    }
    
    if (content) {
      console.log(`回复: ${content.slice(0, 300)}`);
    }

    // 分析请求格式
    if (streamReqHeaders) {
      console.log('\n=== 成功请求的完整 Headers ===');
      const skipH = ['cookie', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'accept-language', 'accept-encoding'];
      for (const [k, v] of Object.entries(streamReqHeaders)) {
        if (skipH.includes(k)) continue;
        console.log(`  ${k}: ${v.length > 100 ? v.slice(0, 100) + '...' : v}`);
      }
    }
    
    if (streamReqBody) {
      console.log(`\n=== 请求 Body ===`);
      console.log(streamReqBody);
    }

    // 现在用 Node.js fetch 重放同样的请求
    console.log('\n\n=== 重放测试 (Node.js fetch) ===');
    
    // 获取最新的 cookies
    const latestCookies = await context.cookies('https://chatglm.cn');
    const cookieStr = latestCookies.map(c => `${c.name}=${c.value}`).join('; ');
    
    // 复制完全一样的 headers（除了签名需要重新生成）
    const crypto = await import('crypto');
    const ts = Date.now().toString();
    const nonce = crypto.randomUUID().replace(/-/g, '');
    const sign = crypto.createHash('md5').update(`${ts}-${nonce}-8a1317a7468aa3ad86e997d08f3f31cb`).digest('hex');
    
    const replayHeaders = { ...streamReqHeaders };
    replayHeaders['x-timestamp'] = ts;
    replayHeaders['x-nonce'] = nonce;
    replayHeaders['x-sign'] = sign;
    replayHeaders['x-request-id'] = crypto.randomUUID().replace(/-/g, '');
    replayHeaders['cookie'] = cookieStr;
    
    // 修改 body 中的消息
    const body = JSON.parse(streamReqBody);
    body.conversation_id = '';
    body.messages = [{ role: 'user', content: [{ type: 'text', text: '你好，一句话介绍一下通义千问' }] }];
    
    const replayResp = await fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
      method: 'POST',
      headers: replayHeaders,
      body: JSON.stringify(body),
    });
    
    console.log(`重放 HTTP: ${replayResp.status}`);
    const replayText = await replayResp.text();
    
    if (replayResp.status === 200) {
      let replayContent = '';
      for (const line of replayText.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const d = JSON.parse(raw);
          if (d.parts) for (const p of d.parts) if (p.content) replayContent = p.content;
        } catch(e) {}
      }
      console.log(`✅ 重放成功！回复: ${replayContent.slice(0, 200)}`);
    } else {
      console.log(`❌ 重放失败: ${replayText.slice(0, 300)}`);
      
      // 对比差异
      console.log('\n原始 vs 重放 headers 对比:');
      for (const k of Object.keys(streamReqHeaders)) {
        if (streamReqHeaders[k] !== replayHeaders[k]) {
          console.log(`  ${k}:`);
          console.log(`    原始: ${(streamReqHeaders[k] || '').slice(0, 80)}`);
          console.log(`    重放: ${(replayHeaders[k] || '').slice(0, 80)}`);
        }
      }
    }
  } else {
    console.log(`\n❌ 页面请求失败: status=${streamRespStatus}`);
    if (streamRespBody) {
      console.log(`响应: ${streamRespBody.slice(0, 300)}`);
    }
  }

  await page.close().catch(() => {});
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
