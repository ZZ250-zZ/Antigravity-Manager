/**
 * 修正后的智谱 + 豆包验证脚本
 * 基于抓包结果修正 API 端点和参数
 */
import { chromium } from 'playwright';
import { randomUUID, createHash } from 'crypto';

async function main() {
  console.log('=== 智谱 + 豆包 修正验证 ===\n');
  
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  if (!context) { console.log('❌ 未连接到浏览器'); process.exit(1); }
  const cookies = await context.cookies();

  await verifyZhipu(context, cookies);
  await verifyDoubao(context, cookies);

  process.exit(0);
}

// ==================== 智谱清言 ====================

async function verifyZhipu(context, cookies) {
  console.log('\n========== 智谱清言 ==========\n');

  const refreshCookie = cookies.find(c => c.name === 'chatglm_refresh_token');
  if (!refreshCookie) {
    console.log('❌ 未找到 chatglm_refresh_token');
    return;
  }
  console.log(`✅ refresh_token (长度: ${refreshCookie.value.length})`);

  const refreshToken = refreshCookie.value;

  // 方案 1：通过页面获取 access_token（浏览器可能已缓存）
  console.log('通过页面获取 access_token...');
  const page = await context.newPage();
  
  let accessToken = null;
  
  // 拦截请求获取 access_token
  page.on('request', req => {
    const auth = req.headers()['authorization'];
    if (auth && auth.startsWith('Bearer ') && req.url().includes('chatglm.cn')) {
      const token = auth.slice(7);
      if (token !== refreshToken && token.length > 50) {
        accessToken = token;
      }
    }
  });

  await page.goto('https://chatglm.cn/main/alltoolsdetail', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(5000);

  if (!accessToken) {
    // 方案 2：尝试不同的 refresh 端点
    console.log('尝试多个 refresh 端点...');
    const endpoints = [
      'https://chatglm.cn/chatglm/user-api/user/refresh',
      'https://chatglm.cn/chatglm/backend-api/v1/user/refresh',
      'https://chatglm.cn/chatglm/mainchat-api/user/refresh',
    ];
    
    for (const url of endpoints) {
      try {
        const ts = Date.now().toString();
        const nonce = randomUUID().replace(/-/g, '');
        const sign = createHash('md5').update(`${ts}-${nonce}-8a1317a7468aa3ad86e997d08f3f31cb`).digest('hex');
        
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${refreshToken}`,
            'Content-Type': 'application/json',
            'App-Name': 'chatglm',
            'Platform': 'pc',
            'X-Sign': sign,
            'X-Nonce': nonce,
            'X-Timestamp': ts,
            'X-Device-Id': randomUUID().replace(/-/g, ''),
            'X-Request-Id': randomUUID().replace(/-/g, ''),
            'Origin': 'https://chatglm.cn',
            'Referer': 'https://chatglm.cn/main/alltoolsdetail',
          },
          body: '{}',
        });
        const data = await resp.json();
        console.log(`  ${url.split('/').slice(-2).join('/')}: ${resp.status} - ${JSON.stringify(data).slice(0, 100)}`);
        
        if (data.result?.accessToken) {
          accessToken = data.result.accessToken;
          console.log('  ✅ 刷新成功！');
          break;
        }
      } catch(e) {
        console.log(`  ${url}: ${e.message}`);
      }
    }
  }

  if (!accessToken) {
    // 方案 3：直接用 refresh_token 当 access_token 试试
    console.log('尝试直接使用 refresh_token 作为 access_token...');
    accessToken = refreshToken;
  }

  await page.close().catch(() => {});

  // 发送聊天请求
  console.log(`\n使用 token 发送聊天请求 (长度: ${accessToken.length})...`);
  
  const ts = Date.now().toString();
  const nonce = randomUUID().replace(/-/g, '');
  const sign = createHash('md5').update(`${ts}-${nonce}-8a1317a7468aa3ad86e997d08f3f31cb`).digest('hex');
  
  try {
    const chatResp = await fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'App-Name': 'chatglm',
        'Platform': 'pc',
        'Version': '0.0.1',
        'X-Sign': sign,
        'X-Nonce': nonce,
        'X-Timestamp': ts,
        'X-Device-Id': randomUUID().replace(/-/g, ''),
        'X-Request-Id': randomUUID().replace(/-/g, ''),
        'Origin': 'https://chatglm.cn',
        'Referer': 'https://chatglm.cn/main/alltoolsdetail',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({
        assistant_id: '65940acff94777010aa6b796',
        conversation_id: '',
        messages: [{ role: 'user', content: [{ type: 'text', text: '你好，一句话介绍自己' }] }],
        meta_data: {
          channel: '', draft_id: '', if_plus_model: false,
          input_question_type: 'xxxx', is_test: false, platform: 'pc', quote_log_id: '',
          chat_mode: 'zero', is_networking: false,
        },
      }),
    });

    const text = await chatResp.text();
    console.log(`  HTTP: ${chatResp.status}, Content-Type: ${chatResp.headers.get('content-type')}`);

    // 解析 SSE
    let content = '', convId = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '') continue;
      try {
        const parsed = JSON.parse(data);
        // 提取内容
        if (parsed.parts) {
          for (const part of parsed.parts) {
            if (part.content) content += part.content;
          }
        }
        if (parsed.conversation_id) convId = parsed.conversation_id;
      } catch(e) {}
    }

    if (content) {
      console.log(`  回复: ${content.slice(0, 200)}`);
      console.log('  ✅ 智谱清言 验证成功！');
      
      // 清理会话
      if (convId) {
        const ts2 = Date.now().toString();
        const nonce2 = randomUUID().replace(/-/g, '');
        const sign2 = createHash('md5').update(`${ts2}-${nonce2}-8a1317a7468aa3ad86e997d08f3f31cb`).digest('hex');
        await fetch('https://chatglm.cn/chatglm/backend-api/assistant/conversation/delete', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'App-Name': 'chatglm', 'X-Sign': sign2, 'X-Nonce': nonce2, 'X-Timestamp': ts2,
            'X-Device-Id': randomUUID().replace(/-/g, ''), 'X-Request-Id': randomUUID().replace(/-/g, ''),
          },
          body: JSON.stringify({ assistant_id: '65940acff94777010aa6b796', conversation_id: convId }),
        }).catch(() => {});
      }
    } else {
      console.log(`  ❌ 未解析到内容`);
      console.log(`  前500字符: ${text.slice(0, 500)}`);
    }
  } catch(e) {
    console.log(`  ❌ ${e.message}`);
  }
}

// ==================== 豆包 ====================

async function verifyDoubao(context, cookies) {
  console.log('\n\n========== 豆包 ==========\n');

  // 先通过抓包获取实际的 API 调用
  const page = await context.newPage();
  
  let capturedChatRequest = null;

  page.on('request', req => {
    if (req.url().includes('/samantha/chat/completion') && req.method() === 'POST') {
      capturedChatRequest = {
        url: req.url(),
        headers: req.headers(),
        body: req.postData(),
      };
      console.log(`[捕获] 聊天请求: ${req.url().slice(0, 100)}`);
    }
  });

  page.on('response', async resp => {
    if (resp.url().includes('/samantha/chat/completion')) {
      console.log(`[响应] ${resp.status()} ${resp.headers()['content-type']?.slice(0, 50)}`);
    }
  });

  console.log('导航到豆包...');
  await page.goto('https://www.doubao.com/chat/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // 尝试发送消息
  console.log('尝试发送消息...');
  
  const inputs = await page.evaluate(() => {
    const elements = [];
    document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]').forEach(el => {
      elements.push({
        tag: el.tagName,
        type: el.type || '',
        placeholder: el.placeholder || '',
        id: el.id || '',
        role: el.getAttribute('role') || '',
      });
    });
    return elements;
  });
  console.log('输入元素:', JSON.stringify(inputs));

  // 尝试多种方式输入
  let sent = false;
  
  // 尝试 textarea
  try {
    const textarea = await page.$('textarea');
    if (textarea) {
      await textarea.click();
      await page.waitForTimeout(300);
      await textarea.type('你好，一句话介绍自己', { delay: 50 });
      await page.waitForTimeout(500);
      
      // 找发送按钮
      const sendBtns = await page.$$('button');
      for (const btn of sendBtns) {
        const text = await btn.textContent().catch(() => '');
        const ariaLabel = await btn.getAttribute('aria-label').catch(() => '');
        if (text.includes('发送') || ariaLabel.includes('send') || ariaLabel.includes('发送')) {
          await btn.click();
          sent = true;
          console.log('✅ 找到发送按钮并点击');
          break;
        }
      }
      
      if (!sent) {
        // 尝试 Enter
        await page.keyboard.press('Enter');
        sent = true;
        console.log('✅ 按 Enter 发送');
      }
    }
  } catch(e) {
    console.log(`textarea 方式失败: ${e.message}`);
  }

  if (!sent) {
    // 尝试 contenteditable
    try {
      const editable = await page.$('[contenteditable="true"]');
      if (editable) {
        await editable.click();
        await page.keyboard.type('你好，一句话介绍自己', { delay: 50 });
        await page.waitForTimeout(500);
        await page.keyboard.press('Enter');
        sent = true;
        console.log('✅ contenteditable 发送');
      }
    } catch(e) {
      console.log(`contenteditable 方式失败: ${e.message}`);
    }
  }

  if (sent) {
    console.log('等待 API 响应 (15秒)...');
    await page.waitForTimeout(15000);
  }

  // 分析捕获的请求
  if (capturedChatRequest) {
    console.log('\n=== 捕获到的豆包聊天请求 ===');
    console.log(`URL: ${capturedChatRequest.url}`);
    
    // 提取关键参数
    const url = new URL(capturedChatRequest.url);
    console.log('Query params:');
    for (const [k, v] of url.searchParams) {
      console.log(`  ${k}: ${v.slice(0, 80)}`);
    }
    
    console.log('\nHeaders:');
    const importantHeaders = ['cookie', 'content-type', 'agw-js-conv', 'x-flow-trace', 'referer', 'origin'];
    for (const h of importantHeaders) {
      if (capturedChatRequest.headers[h]) {
        let val = capturedChatRequest.headers[h];
        if (h === 'cookie') val = val.split(';').map(c => c.trim().split('=')[0]).join(', ');
        if (val.length > 150) val = val.slice(0, 150) + '...';
        console.log(`  ${h}: ${val}`);
      }
    }
    
    if (capturedChatRequest.body) {
      console.log(`\nBody: ${capturedChatRequest.body.slice(0, 1000)}`);
    }
    
    console.log('\n✅ 豆包 API 请求已捕获！');
  } else {
    console.log('\n⚠️ 未捕获到聊天请求');
    
    // 提取 cookie 信息
    const doubaoCookies = cookies.filter(c => c.domain.includes('doubao'));
    console.log('\n豆包相关 Cookies:');
    doubaoCookies.forEach(c => console.log(`  ${c.name} (domain: ${c.domain}, len: ${c.value.length})`));
  }

  await page.close().catch(() => {});
}

main().catch(e => { console.error(e); process.exit(1); });
