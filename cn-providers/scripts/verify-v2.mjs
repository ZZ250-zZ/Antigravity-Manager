/**
 * 智谱 + 豆包 API 精确验证 v2
 * 基于抓包的真实请求格式
 */
import { chromium } from 'playwright';
import { randomUUID, createHash } from 'crypto';

const target = process.argv[2] || 'all'; // zhipu / doubao / all

async function main() {
  console.log('=== API 精确验证 v2 ===\n');
  
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  if (!context) { console.log('❌ 未连接到浏览器'); process.exit(1); }

  if (target === 'zhipu' || target === 'all') await verifyZhipu(context);
  if (target === 'doubao' || target === 'all') await verifyDoubao(context);

  process.exit(0);
}

// ==================== 智谱清言 ====================
async function verifyZhipu(context) {
  console.log('\n========== 智谱清言 ==========\n');

  // Step 1: 从浏览器页面获取 access_token
  const page = await context.newPage();
  
  let accessToken = null;
  
  // 拦截所有请求的 authorization header
  page.on('request', req => {
    if (!accessToken && req.url().includes('chatglm.cn')) {
      const auth = req.headers()['authorization'];
      if (auth && auth.startsWith('Bearer ')) {
        accessToken = auth.slice(7);
      }
    }
  });

  await page.goto('https://chatglm.cn/main/alltoolsdetail', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);

  // 也尝试从 localStorage / sessionStorage 获取
  if (!accessToken) {
    accessToken = await page.evaluate(() => {
      for (const storage of [localStorage, sessionStorage]) {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          const val = storage.getItem(key);
          if (val && val.startsWith('eyJ') && val.length > 100) {
            return val;
          }
        }
      }
      return null;
    });
  }

  await page.close().catch(() => {});

  if (!accessToken) {
    console.log('❌ 无法获取 access_token');
    return;
  }
  console.log(`✅ access_token (长度: ${accessToken.length})`);

  // 解码 JWT 查看过期时间
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64').toString());
    const exp = new Date(payload.exp * 1000);
    const iat = new Date(payload.iat * 1000);
    console.log(`  签发: ${iat.toLocaleString()}, 过期: ${exp.toLocaleString()}`);
    console.log(`  有效期: ${((payload.exp - payload.iat) / 3600).toFixed(1)} 小时`);
    if (Date.now() > payload.exp * 1000) {
      console.log('  ⚠️ Token 已过期！');
    }
  } catch(e) {}

  // Step 2: 用捕获的真实格式发送请求
  console.log('\n发送聊天请求...');
  
  const ts = Date.now().toString();
  const nonce = randomUUID().replace(/-/g, '');
  const deviceId = randomUUID().replace(/-/g, '');
  const requestId = randomUUID().replace(/-/g, '');
  const sign = createHash('md5').update(`${ts}-${nonce}-8a1317a7468aa3ad86e997d08f3f31cb`).digest('hex');

  const resp = await fetch('https://chatglm.cn/chatglm/backend-api/assistant/stream', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'App-Name': 'chatglm',
      'X-App-Platform': 'pc',
      'X-App-Version': '0.0.1',
      'X-App-Fr': 'default',
      'X-Lang': 'zh',
      'X-Sign': sign,
      'X-Nonce': nonce,
      'X-Timestamp': ts,
      'X-Device-Id': deviceId,
      'X-Request-Id': requestId,
      'Origin': 'https://chatglm.cn',
      'Referer': 'https://chatglm.cn/main/alltoolsdetail',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0',
    },
    body: JSON.stringify({
      assistant_id: '65940acff94777010aa6b796',
      conversation_id: '',
      project_id: '',
      chat_type: 'user_chat',
      meta_data: {
        cogview: { rm_label_watermark: false },
        is_test: false,
        input_question_type: 'xxxx',
        channel: '',
        draft_id: '',
        chat_mode: 'zero',
        is_networking: false,
        quote_log_id: '',
        platform: 'pc',
      },
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好，一句话介绍自己' }] }],
    }),
  });

  console.log(`  HTTP: ${resp.status}, Content-Type: ${resp.headers.get('content-type')}`);
  
  const text = await resp.text();
  let content = '', convId = '';
  
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const raw = line.slice(6).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const d = JSON.parse(raw);
      if (d.parts) {
        for (const p of d.parts) {
          if (p.content) content = p.content; // 最后一个 part 包含完整内容
        }
      }
      if (d.conversation_id) convId = d.conversation_id;
    } catch(e) {}
  }

  if (content) {
    console.log(`  回复: ${content.slice(0, 200)}`);
    console.log('  ✅ 智谱清言 聊天 API 验证成功！');

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
          'App-Name': 'chatglm',
          'X-App-Platform': 'pc',
          'X-Sign': sign2,
          'X-Nonce': nonce2,
          'X-Timestamp': ts2,
          'X-Device-Id': deviceId,
          'X-Request-Id': randomUUID().replace(/-/g, ''),
        },
        body: JSON.stringify({ assistant_id: '65940acff94777010aa6b796', conversation_id: convId }),
      }).catch(() => {});
      console.log(`  会话 ${convId} 已清理`);
    }
  } else {
    console.log(`  ❌ 未解析到内容`);
    console.log(`  前300字符: ${text.slice(0, 300)}`);
  }

  // Step 3: 验证 token refresh 机制
  console.log('\n验证 Token Refresh 机制...');
  const cookies = await context.cookies('https://chatglm.cn');
  const refreshCookie = cookies.find(c => c.name === 'chatglm_refresh_token');
  if (refreshCookie) {
    console.log(`  refresh_token (长度: ${refreshCookie.value.length})`);
    
    // 尝试各种 refresh 端点
    const refreshEndpoints = [
      'https://chatglm.cn/chatglm/user-api/user/refresh',
      'https://chatglm.cn/chatglm/backend-api/user/refresh',
      'https://chatglm.cn/chatglm/mainchat-api/user/refresh',
    ];
    
    for (const url of refreshEndpoints) {
      const ts3 = Date.now().toString();
      const nonce3 = randomUUID().replace(/-/g, '');
      const sign3 = createHash('md5').update(`${ts3}-${nonce3}-8a1317a7468aa3ad86e997d08f3f31cb`).digest('hex');
      
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${refreshCookie.value}`,
            'Content-Type': 'application/json',
            'App-Name': 'chatglm',
            'X-App-Platform': 'pc',
            'X-App-Version': '0.0.1',
            'X-App-Fr': 'default',
            'X-Lang': 'zh',
            'X-Sign': sign3,
            'X-Nonce': nonce3,
            'X-Timestamp': ts3,
            'X-Device-Id': deviceId || randomUUID().replace(/-/g, ''),
            'X-Request-Id': randomUUID().replace(/-/g, ''),
            'Origin': 'https://chatglm.cn',
            'Referer': 'https://chatglm.cn/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          body: '{}',
        });
        const data = await r.text();
        console.log(`  ${url.split('chatglm.cn')[1]}: ${r.status}`);
        if (r.status === 200) {
          const parsed = JSON.parse(data);
          if (parsed.result?.accessToken) {
            console.log(`    ✅ Refresh 成功！ access_token 长度: ${parsed.result.accessToken.length}`);
          } else {
            console.log(`    结果: ${data.slice(0, 150)}`);
          }
        } else {
          console.log(`    ${data.slice(0, 100)}`);
        }
      } catch(e) {
        console.log(`  ${url}: ${e.message}`);
      }
    }
  }
}

// ==================== 豆包 ====================
async function verifyDoubao(context) {
  console.log('\n\n========== 豆包 ==========\n');

  const page = await context.newPage();
  
  // 收集所有 API 请求和响应
  const capturedRequests = [];
  let chatApiFound = false;
  let chatResponseText = '';
  
  page.on('request', req => {
    const url = req.url();
    if (url.includes('doubao.com') && !url.includes('.js') && !url.includes('.css') && !url.includes('.png') && !url.includes('.svg') && !url.includes('.ico') && !url.includes('.woff')) {
      const entry = {
        url, method: req.method(),
        headers: req.headers(),
        body: req.postData() || null,
      };
      capturedRequests.push(entry);
      
      // 关注聊天相关请求
      if (url.includes('chat') || url.includes('samantha') || url.includes('conversation') || url.includes('completion')) {
        console.log(`[REQ] ${req.method()} ${url.slice(0, 120)}`);
      }
    }
  });

  page.on('response', async resp => {
    const url = resp.url();
    if (url.includes('chat/completion') || url.includes('samantha')) {
      const ct = resp.headers()['content-type'] || '';
      console.log(`[RESP] ${resp.status()} ${url.slice(0, 120)} (${ct.slice(0, 50)})`);
      if (resp.status() === 200 && (ct.includes('stream') || ct.includes('text'))) {
        try {
          chatResponseText = await resp.text();
        } catch(e) {}
      }
    }
  });

  console.log('导航到豆包...');
  await page.goto('https://www.doubao.com/chat/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // 检查页面加载的 API 调用
  const apiCalls = capturedRequests.filter(r => !r.url.includes('slardar') && !r.url.includes('toblog') && !r.url.includes('mssdk'));
  console.log(`\n页面加载 API 调用: ${apiCalls.length} 个`);
  for (const r of apiCalls.slice(0, 10)) {
    const path = new URL(r.url).pathname;
    console.log(`  ${r.method} ${path}`);
  }

  // 查找输入元素
  console.log('\n查找输入元素...');
  const inputInfo = await page.evaluate(() => {
    const results = [];
    // 查找所有可能的输入元素
    const selectors = [
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]',
      'input[type="text"]',
    ];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => {
        const rect = el.getBoundingClientRect();
        results.push({
          selector: sel,
          tag: el.tagName,
          placeholder: el.placeholder || el.getAttribute('data-placeholder') || '',
          visible: rect.width > 0 && rect.height > 0,
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        });
      });
    }
    return results;
  });
  
  for (const info of inputInfo) {
    console.log(`  ${info.selector}: ${info.tag} placeholder="${info.placeholder}" visible=${info.visible} [${info.rect.w}x${info.rect.h}]`);
  }

  // 找到可见的 textarea 并输入
  const visibleTextarea = inputInfo.find(i => i.selector === 'textarea' && i.visible && i.placeholder.includes('发消息'));
  
  capturedRequests.length = 0; // 重置
  chatApiFound = false;

  if (visibleTextarea) {
    console.log(`\n找到输入框 (placeholder: "${visibleTextarea.placeholder}")，输入消息...`);
    
    // 点击 textarea
    const textareaEl = await page.$('textarea[placeholder*="发消息"]');
    if (textareaEl) {
      await textareaEl.click();
      await page.waitForTimeout(500);
      await textareaEl.fill('你好，一句话介绍自己');
      await page.waitForTimeout(500);
      
      // 截图看看按钮
      const buttons = await page.evaluate(() => {
        const btns = [];
        document.querySelectorAll('button, [role="button"]').forEach(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const text = el.textContent?.trim()?.slice(0, 30) || '';
            const ariaLabel = el.getAttribute('aria-label') || '';
            const dataTestId = el.getAttribute('data-testid') || '';
            // 只关注可能的发送按钮
            if (text || ariaLabel || dataTestId) {
              btns.push({ text, ariaLabel, dataTestId, x: rect.x, y: rect.y });
            }
          }
        });
        return btns;
      });
      
      console.log('可见按钮:');
      for (const btn of buttons.slice(0, 20)) {
        console.log(`  text="${btn.text.slice(0,20)}" aria="${btn.ariaLabel}" testid="${btn.dataTestId}" pos=(${btn.x.toFixed(0)},${btn.y.toFixed(0)})`);
      }

      // 直接按 Enter 发送
      console.log('\n按 Enter 发送...');
      await page.keyboard.press('Enter');
      
      console.log('等待 API 响应 (15秒)...');
      await page.waitForTimeout(15000);
    }
  } else {
    console.log('⚠️ 未找到输入框');
  }

  // 分析捕获的请求
  console.log(`\n发送后 ${capturedRequests.length} 个新请求`);
  
  const chatReqs = capturedRequests.filter(r => 
    r.url.includes('chat') || r.url.includes('completion') || r.url.includes('samantha') || r.url.includes('conversation')
  );

  if (chatReqs.length > 0) {
    console.log('\n=== 聊天相关请求 ===');
    for (const r of chatReqs) {
      console.log(`\n${r.method} ${r.url}`);
      
      // 提取关键 headers
      console.log('Headers:');
      const skipHeaders = ['cookie', 'sec-fetch-site', 'sec-fetch-mode', 'sec-ch-ua', 'accept-language', 'accept-encoding', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'];
      for (const [k, v] of Object.entries(r.headers)) {
        if (skipHeaders.includes(k)) continue;
        let val = v;
        if (val.length > 200) val = val.slice(0, 200) + '...';
        console.log(`  ${k}: ${val}`);
      }
      
      // 提取 cookie 名称
      if (r.headers['cookie']) {
        const cookieNames = r.headers['cookie'].split(';').map(c => c.trim().split('=')[0]);
        console.log(`  Cookies: ${cookieNames.join(', ')}`);
      }
      
      if (r.body) {
        console.log(`Body: ${r.body.slice(0, 2000)}`);
      }
    }
  } else {
    console.log('\n未捕获到聊天请求');
    
    // 打印所有 POST 请求
    const postReqs = capturedRequests.filter(r => r.method === 'POST');
    if (postReqs.length > 0) {
      console.log('\n所有 POST 请求:');
      for (const r of postReqs) {
        const path = new URL(r.url).pathname;
        console.log(`  ${path}`);
      }
    }
  }

  // 输出 cookies
  const doubaoCookies = (await context.cookies('https://www.doubao.com')).filter(
    c => ['sessionid', 'sid_tt', 'odin_tt', 'uid_tt', 'ttwid', 'msToken', 'flow_cur_user_sec_id'].includes(c.name)
  );
  console.log('\n关键 Cookies:');
  for (const c of doubaoCookies) {
    console.log(`  ${c.name}: ${c.value.slice(0, 20)}... (len: ${c.value.length})`);
  }

  await page.close().catch(() => {});
}

main().catch(e => { console.error(e); process.exit(1); });
