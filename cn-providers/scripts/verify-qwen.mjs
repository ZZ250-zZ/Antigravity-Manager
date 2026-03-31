/**
 * Qwen Web API 协议验证脚本
 * 
 * 两种模式:
 * 1. --cdp: 连接已运行的 Edge（需先启动带调试端口的 Edge）
 * 2. 默认: 使用 Edge 用户 Profile（需先关闭所有 Edge 窗口）
 * 
 * 用法:
 *   关闭 Edge 后: node scripts/verify-qwen.mjs
 *   不关闭 Edge:  先运行以下命令启动 Edge 调试实例：
 *     "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222
 *     然后: node scripts/verify-qwen.mjs --cdp
 */
import { chromium } from 'playwright';
import http2 from 'http2';
import { randomUUID } from 'crypto';
import path from 'path';
import os from 'os';

const EDGE_USER_DATA_DIR = path.join(
  os.homedir(),
  'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'
);

const QWEN_URLS = {
  home: 'https://tongyi.aliyun.com/qianwen',
  bizApi: 'https://qianwen.biz.aliyun.com',
};

const useCdp = process.argv.includes('--cdp');

async function main() {
  console.log('=== Qwen Web API 协议验证 ===\n');

  let context;
  let browser;

  if (useCdp) {
    // 连接到已运行的 Edge（通过 CDP）
    console.log('1. 连接到已运行的 Edge (CDP 模式, port 9222)...');
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    context = browser.contexts()[0];
    if (!context) {
      console.log('❌ 未找到浏览器上下文，请确保 Edge 已打开页面');
      return;
    }
  } else {
    // 使用用户 Profile（需关闭 Edge）
    console.log('1. 启动 Edge（加载你的登录信息）...');
    console.log(`   Profile: ${EDGE_USER_DATA_DIR}\\Default`);
    console.log('   ⚠️ 如果报错，请先关闭所有 Edge 窗口\n');
    context = await chromium.launchPersistentContext(
      path.join(EDGE_USER_DATA_DIR, 'Default'),
      {
        channel: 'msedge',
        headless: false,
        args: ['--disable-blink-features=AutomationControlled'],
        viewport: { width: 1280, height: 800 },
      }
    );
  }

  const page = context.pages()[0] || await context.newPage();

  // 2. 访问通义千问
  console.log('2. 访问通义千问...');
  await page.goto(QWEN_URLS.home, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // 3. 提取 Cookies
  console.log('3. 提取 Cookies...');
  const cookies = await context.cookies();

  const ticketNames = ['tongyi_sso_ticket', 'login_aliyunid_ticket', 'login_tongyi_ticket'];
  let ticketCookie = null;
  for (const name of ticketNames) {
    ticketCookie = cookies.find(c => c.name === name);
    if (ticketCookie) break;
  }

  // 打印所有相关 cookie
  console.log('\n   相关 Cookies:');
  const relevantDomains = ['aliyun', 'tongyi', 'qianwen'];
  cookies
    .filter(c => relevantDomains.some(d => c.domain.includes(d)))
    .forEach(c => console.log(`   - ${c.name} (domain: ${c.domain}, len: ${c.value.length})`));

  if (!ticketCookie) {
    console.log('\n❌ 未找到 ticket Cookie，可能需要登录。');
    console.log('\n请在浏览器中登录后，按 Enter 重试...');
    await waitForInput();
    
    const newCookies = await context.cookies();
    for (const name of ticketNames) {
      ticketCookie = newCookies.find(c => c.name === name);
      if (ticketCookie) break;
    }
    
    if (!ticketCookie) {
      console.log('❌ 登录后仍未找到 ticket Cookie');
      await cleanup(context, browser);
      return;
    }
  }

  console.log(`\n✅ 找到 ticket: ${ticketCookie.name} (长度: ${ticketCookie.value.length})`);
  await verifyApi(ticketCookie);

  await cleanup(context, browser);
}

async function cleanup(context, browser) {
  console.log('\n关闭浏览器...');
  if (browser) {
    await browser.close().catch(() => {});
  } else {
    await context.close().catch(() => {});
  }
}

function waitForInput() {
  return new Promise(resolve => {
    process.stdin.once('data', resolve);
  });
}

/**
 * 验证 Qwen biz API
 */
async function verifyApi(ticketCookie) {
  const ticket = ticketCookie.value;
  const cookieName = ticketCookie.name;

  console.log(`\n=== 使用 ${cookieName} 验证 API ===\n`);

  // 构建 Cookie（参考 qwen-free-api 的 generateCookie 方法）
  const cookieStr = [
    `${cookieName}=${ticket}`,
    'aliyun_choice=intl',
    '_samesite_flag_=true',
    `t=${randomUUID().replace(/-/g, '')}`,
  ].join('; ');

  const fakeHeaders = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cache-Control': 'no-cache',
    'Origin': 'https://tongyi.aliyun.com',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    'Referer': 'https://tongyi.aliyun.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'X-Platform': 'pc_tongyi',
    'X-Xsrf-Token': '48b9ee49-a184-45e2-9f67-fa87213edcdc',
  };

  // ========== Test 1: 验证 Token（获取会话列表）==========
  console.log('Test 1: 验证 Token 有效性 (POST /dialog/session/list)...');
  try {
    const resp = await fetch(`${QWEN_URLS.bizApi}/dialog/session/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieStr, ...fakeHeaders },
      body: JSON.stringify({}),
    });
    const text = await resp.text();
    console.log(`  HTTP 状态: ${resp.status}`);
    console.log(`  响应体: ${text.slice(0, 300)}`);
    
    if (resp.status === 200) {
      try {
        const json = JSON.parse(text);
        if (json.success || json.errorCode === undefined) {
          console.log('  ✅ Token 有效');
        } else {
          console.log(`  ⚠️ 响应异常: errorCode=${json.errorCode}, errorMsg=${json.errorMsg}`);
        }
      } catch(e) {
        console.log('  ⚠️ 响应不是 JSON');
      }
    } else {
      console.log('  ❌ Token 无效或请求被拒');
      return;
    }
  } catch (e) {
    console.log(`  ❌ 请求失败: ${e.message}`);
    return;
  }

  // ========== Test 2: 发送聊天 (HTTP/2 SSE) ==========
  console.log('\nTest 2: 聊天请求 (HTTP/2 SSE, POST /dialog/conversation)...');
  try {
    const chatBody = {
      mode: 'chat',
      model: '',
      action: 'next',
      userAction: 'chat',
      requestId: randomUUID().replace(/-/g, ''),
      sessionId: '',
      sessionType: 'text_chat',
      parentMsgId: '',
      params: { fileUploadBatchId: randomUUID() },
      contents: [
        {
          role: 'user',
          contentType: 'text',
          content: '请用一句话介绍你自己',
        },
      ],
    };

    const result = await http2Post(
      QWEN_URLS.bizApi,
      '/dialog/conversation',
      chatBody,
      {
        'Content-Type': 'application/json',
        'Cookie': cookieStr,
        ...fakeHeaders,
        'Accept': 'text/event-stream',
      }
    );

    console.log(`  HTTP 状态: ${result.status}`);
    console.log(`  Content-Type: ${result.contentType}`);
    console.log(`  SSE 事件数: ${result.events.length}`);

    if (result.events.length > 0) {
      // 打印前3个和最后1个事件
      const showEvents = result.events.slice(0, 3);
      showEvents.forEach((evt, i) => {
        console.log(`  事件[${i}]: ${evt.data?.slice(0, 200) || '(empty)'}...`);
      });
      if (result.events.length > 3) {
        const last = result.events[result.events.length - 1];
        console.log(`  事件[${result.events.length - 1}]: ${last.data?.slice(0, 200) || '(empty)'}...`);
      }

      // 提取完整回复
      let fullContent = '';
      let sessionId = '';
      for (const evt of result.events) {
        if (!evt.data) continue;
        try {
          const parsed = JSON.parse(evt.data);
          if (parsed.sessionId) sessionId = parsed.sessionId;
          if (parsed.contents) {
            for (const c of parsed.contents) {
              if (c.content) fullContent = c.content;
            }
          }
        } catch(e) { /* skip */ }
      }

      if (fullContent) {
        console.log(`\n  === 模型回复 ===`);
        console.log(`  ${fullContent.slice(0, 500)}`);
      }
      console.log('\n  ✅ 聊天 API 正常工作！');

      // 清理会话
      if (sessionId) {
        console.log(`  清理会话 ${sessionId}...`);
        await fetch(`${QWEN_URLS.bizApi}/dialog/session/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookieStr, ...fakeHeaders },
          body: JSON.stringify({ sessionId }),
        }).catch(() => {});
      }
    } else {
      console.log('  ⚠️ 未收到 SSE 事件');
      console.log(`  原始响应: ${result.rawBody.slice(0, 500)}`);
    }
  } catch (e) {
    console.log(`  ❌ 聊天请求失败: ${e.message}`);
    console.log(e.stack);
  }

  console.log('\n=== Qwen 验证完成 ===');
}

/**
 * HTTP/2 POST with SSE response parsing
 */
function http2Post(authority, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const session = http2.connect(authority);
    session.on('error', (err) => {
      reject(new Error(`HTTP/2 连接失败: ${err.message}`));
    });

    const req = session.request({
      ':method': 'POST',
      ':path': urlPath,
      ...headers,
    });
    req.setTimeout(60000);
    req.write(JSON.stringify(body));
    req.end();

    let rawBody = '';
    let status = 0;
    let contentType = '';
    const events = [];

    req.on('response', (h) => {
      status = h[':status'];
      contentType = h['content-type'] || '';
    });

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      rawBody += chunk;
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data:')) {
          events.push({ data: trimmed.slice(5).trim() });
        }
      }
    });

    req.on('end', () => {
      session.close();
      resolve({ status, contentType, events, rawBody });
    });

    req.on('error', (e) => {
      session.close();
      reject(e);
    });

    setTimeout(() => {
      req.close();
      session.close();
      resolve({ status, contentType, events, rawBody });
    }, 60000);
  });
}

main().catch(console.error);
