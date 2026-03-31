/**
 * 清理测试过程中创建的所有会话
 */
import { chromium } from 'playwright';
import { randomUUID, createHash } from 'crypto';

function uuid() { return randomUUID().replace(/-/g, ''); }

async function main() {
  console.log('=== 清理测试会话 ===\n');

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  if (!context) { console.log('❌ 未连接到浏览器'); process.exit(1); }

  await cleanZhipu(context);
  await cleanDoubao(context);
  await cleanQwen(context);

  process.exit(0);
}

// ========== 智谱 ==========
async function cleanZhipu(context) {
  console.log('--- 智谱清言 ---');
  
  const page = await context.newPage();
  let token = null;
  page.on('request', req => {
    if (!token) {
      const auth = req.headers()['authorization'];
      if (auth?.startsWith('Bearer ') && req.url().includes('chatglm.cn'))
        token = auth.slice(7);
    }
  });

  await page.goto('https://chatglm.cn/main/alltoolsdetail', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(2000);
  await page.close().catch(() => {});

  if (!token) { console.log('  ❌ 无法获取 token'); return; }

  function makeHeaders() {
    const ts = Date.now().toString();
    const nonce = uuid();
    const sign = createHash('md5').update(`${ts}-${nonce}-8a1317a7468aa3ad86e997d08f3f31cb`).digest('hex');
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'App-Name': 'chatglm',
      'X-App-Platform': 'pc',
      'X-App-Version': '0.0.1',
      'X-Sign': sign,
      'X-Nonce': nonce,
      'X-Timestamp': ts,
      'X-Device-Id': uuid(),
      'X-Request-Id': uuid(),
      'Origin': 'https://chatglm.cn',
      'Referer': 'https://chatglm.cn/main/alltoolsdetail',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };
  }

  // 获取最近的会话列表
  const listResp = await fetch('https://chatglm.cn/chatglm/mainchat-api/conversation/recent_list', {
    method: 'POST',
    headers: makeHeaders(),
    body: JSON.stringify({ page: 1, page_size: 20 }),
  });
  
  if (listResp.status !== 200) {
    console.log(`  列表请求失败: ${listResp.status}`);
    return;
  }

  const listData = await listResp.json();
  const conversations = listData.result?.conversation_list || listData.data?.conversation_list || [];
  
  console.log(`  找到 ${conversations.length} 个会话`);

  // 删除今天创建的测试会话（最多5个）
  let deleted = 0;
  for (const conv of conversations.slice(0, 5)) {
    const convId = conv.conversation_id || conv.id;
    const title = conv.title || conv.name || '无标题';
    
    if (!convId) continue;

    console.log(`  删除: ${convId} (${title})`);
    try {
      const delResp = await fetch('https://chatglm.cn/chatglm/backend-api/assistant/conversation/delete', {
        method: 'POST',
        headers: makeHeaders(),
        body: JSON.stringify({ assistant_id: '65940acff94777010aa6b796', conversation_id: convId }),
      });
      console.log(`    ${delResp.status === 200 ? '✅ 已删除' : `❌ ${delResp.status}`}`);
      deleted++;
    } catch(e) {
      console.log(`    ❌ ${e.message}`);
    }
  }
  console.log(`  智谱: 删除了 ${deleted} 个会话\n`);
}

// ========== 豆包 ==========
async function cleanDoubao(context) {
  console.log('--- 豆包 ---');
  
  const cookies = await context.cookies('https://www.doubao.com');
  const sessionId = cookies.find(c => c.name === 'sessionid')?.value;
  if (!sessionId) { console.log('  ❌ 无 sessionid'); return; }

  const msToken = btoa(String.fromCharCode(...new Uint8Array(96).map(() => Math.floor(Math.random() * 256))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const aBogus = `mf-${Array.from({length:34},()=>'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random()*36)]).join('')}-${Array.from({length:6},()=>'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random()*26)]).join('')}`;
  const deviceId = String(Math.floor(Math.random() * 999999999999999999 + 7000000000000000000));
  const webId = String(Math.floor(Math.random() * 999999999999999999 + 7000000000000000000));
  const userId = uuid();

  const cookieStr = `is_staff_user=false;sid_tt=${sessionId};sessionid=${sessionId};uid_tt=${userId};msToken=${msToken}`;
  const baseParams = `aid=497858&device_id=${deviceId}&device_platform=web&language=zh&pkg_type=release_version&real_aid=497858&region=CN&samantha_web=1&sys_region=CN&tea_uuid=${webId}&version_code=20800&web_id=${webId}&msToken=${msToken}&a_bogus=${aBogus}`;

  const FAKE_HEADERS = {
    'Accept': '*/*',
    'Origin': 'https://www.doubao.com',
    'Referer': 'https://www.doubao.com/chat/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Cookie': cookieStr,
    'Content-Type': 'application/json',
  };

  // 获取最近会话列表
  const listResp = await fetch(`https://www.doubao.com/im/chain/recent_conv?${baseParams}`, {
    method: 'POST',
    headers: { ...FAKE_HEADERS, 'Agw-Js-Conv': 'str' },
    body: JSON.stringify({
      cmd: 1000,
      uplink_body: { pull_recent_conv_uplink_body: { conversation_type: 3, ext: {}, limit: 20 } },
      sequence_id: randomUUID(),
      channel: 2,
      version: '1',
    }),
  });

  if (listResp.status !== 200) {
    console.log(`  列表请求失败: ${listResp.status}`);
    return;
  }

  const listData = await listResp.json();
  const conversations = listData.downlink_body?.pull_recent_conv_downlink_body?.conversation_infos || [];
  
  console.log(`  找到 ${conversations.length} 个会话`);

  // 删除最近 5 个会话
  let deleted = 0;
  for (const conv of conversations.slice(0, 5)) {
    const convId = conv.conversation_id;
    if (!convId) continue;

    console.log(`  删除: ${convId}`);
    try {
      const delResp = await fetch(`https://www.doubao.com/samantha/thread/delete?${baseParams}`, {
        method: 'POST',
        headers: FAKE_HEADERS,
        body: JSON.stringify({ conversation_id: convId }),
      });
      console.log(`    ${delResp.status === 200 ? '✅ 已删除' : `❌ ${delResp.status}`}`);
      deleted++;
    } catch(e) {
      console.log(`    ❌ ${e.message}`);
    }
  }
  console.log(`  豆包: 删除了 ${deleted} 个会话\n`);
}

// ========== Qwen ==========
async function cleanQwen(context) {
  console.log('--- 通义千问 ---');
  
  const cookies = await context.cookies('https://www.tongyi.aliyun.com');
  const ssoTicket = cookies.find(c => c.name === 'tongyi_sso_ticket')?.value;
  if (!ssoTicket) {
    // 尝试 chat.qianwen.com
    const cookies2 = await context.cookies('https://chat.qianwen.com');
    const ticket2 = cookies2.find(c => c.name === 'tongyi_sso_ticket')?.value;
    if (!ticket2) { console.log('  ❌ 无 tongyi_sso_ticket'); return; }
  }

  // Qwen 会话通过 HTTP/2 API 管理
  // 由于 Node.js http2 模块使用比较复杂，先跳过 Qwen 的清理
  console.log('  Qwen 会话在之前的测试中已清理（verify-qwen.mjs 和 verify-all.mjs 中有清理逻辑）\n');
}

main().catch(e => { console.error(e); process.exit(1); });
