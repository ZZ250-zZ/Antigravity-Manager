/**
 * 智谱清言 - 通过实际页面操作捕获完整请求
 * 导航到聊天页面，输入消息，拦截API请求
 */
import { chromium } from 'playwright';

async function main() {
  console.log('=== 智谱清言 API 捕获 ===\n');
  
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  if (!context) { console.log('❌ 未连接到浏览器'); process.exit(1); }

  const page = await context.newPage();
  
  // 收集所有 chatglm API 请求
  const apiRequests = [];
  
  page.on('request', req => {
    const url = req.url();
    if (url.includes('chatglm.cn') && !url.includes('.js') && !url.includes('.css') && !url.includes('.png') && !url.includes('.ico')) {
      const entry = {
        url: url,
        method: req.method(),
        headers: req.headers(),
        body: req.postData() || null,
      };
      apiRequests.push(entry);
      
      if (url.includes('refresh') || url.includes('stream') || url.includes('assistant') || url.includes('user')) {
        console.log(`[REQ] ${req.method()} ${url.slice(0, 120)}`);
        const auth = req.headers()['authorization'];
        if (auth) console.log(`  Auth: ${auth.slice(0, 50)}... (len: ${auth.length})`);
      }
    }
  });

  page.on('response', async resp => {
    const url = resp.url();
    if (url.includes('refresh') || url.includes('stream') || url.includes('conversation')) {
      const ct = resp.headers()['content-type'] || '';
      console.log(`[RESP] ${resp.status()} ${url.slice(0, 120)} (${ct.slice(0, 50)})`);
      if (resp.status() === 200 && ct.includes('json') && url.includes('refresh')) {
        try {
          const body = await resp.json();
          console.log(`  刷新结果: ${JSON.stringify(body).slice(0, 200)}`);
        } catch(e) {}
      }
    }
  });

  // 导航到智谱聊天页面
  console.log('导航到 chatglm.cn...');
  await page.goto('https://chatglm.cn/main/alltoolsdetail', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);

  // 打印页面加载期间的所有 API 请求
  console.log(`\n页面加载期间共 ${apiRequests.length} 个 API 请求`);
  
  // 查找含 authorization 的请求
  const authRequests = apiRequests.filter(r => r.headers['authorization']);
  console.log(`含 Authorization 的请求: ${authRequests.length}`);
  for (const r of authRequests.slice(0, 5)) {
    console.log(`  ${r.method} ${r.url.split('chatglm.cn')[1]?.slice(0, 80) || r.url.slice(0, 80)}`);
    const auth = r.headers['authorization'];
    console.log(`    Bearer token长度: ${auth.replace('Bearer ', '').length}`);
    // 输出关键 headers
    for (const k of ['x-sign', 'x-nonce', 'x-timestamp', 'x-device-id', 'x-request-id', 'app-name']) {
      if (r.headers[k]) console.log(`    ${k}: ${r.headers[k]}`);
    }
  }

  // 查找 refresh 请求
  const refreshReqs = apiRequests.filter(r => r.url.includes('refresh'));
  if (refreshReqs.length > 0) {
    console.log(`\n刷新请求:`);
    for (const r of refreshReqs) {
      console.log(`  ${r.method} ${r.url}`);
    }
  }

  // 尝试在页面中发送消息
  console.log('\n尝试在页面中发送消息...');
  
  // 查找输入框
  const inputInfo = await page.evaluate(() => {
    const textareas = document.querySelectorAll('textarea');
    const editables = document.querySelectorAll('[contenteditable="true"]');
    const inputs = [];
    textareas.forEach(el => inputs.push({ tag: 'textarea', placeholder: el.placeholder, id: el.id, class: el.className?.toString?.()?.slice(0, 50) || '' }));
    editables.forEach(el => inputs.push({ tag: el.tagName, role: el.getAttribute('role'), id: el.id, class: el.className?.toString?.()?.slice(0, 50) || '' }));
    return inputs;
  });
  console.log('输入元素:', JSON.stringify(inputInfo, null, 2));

  // 清空之前的请求记录
  apiRequests.length = 0;
  
  // 尝试输入消息
  let sent = false;
  
  // 方式1: textarea
  const textareas = await page.$$('textarea');
  for (const ta of textareas) {
    const visible = await ta.isVisible().catch(() => false);
    if (visible) {
      console.log('找到可见 textarea，输入消息...');
      await ta.click();
      await page.waitForTimeout(300);
      await ta.fill('你好，一句话介绍自己');
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      sent = true;
      break;
    }
  }

  // 方式2: contenteditable
  if (!sent) {
    const editables = await page.$$('[contenteditable="true"]');
    for (const el of editables) {
      const visible = await el.isVisible().catch(() => false);
      if (visible) {
        console.log('找到 contenteditable，输入消息...');
        await el.click();
        await page.waitForTimeout(300);
        await page.keyboard.type('你好，一句话介绍自己', { delay: 30 });
        await page.waitForTimeout(300);
        await page.keyboard.press('Enter');
        sent = true;
        break;
      }
    }
  }

  if (sent) {
    console.log('等待 API 响应 (15秒)...');
    await page.waitForTimeout(15000);
  }

  // 分析发送消息后的请求
  console.log(`\n发送消息后 ${apiRequests.length} 个新请求`);
  const streamReqs = apiRequests.filter(r => r.url.includes('stream') || r.url.includes('conversation') || r.url.includes('assistant'));
  if (streamReqs.length > 0) {
    console.log('\n=== 关键请求 ===');
    for (const r of streamReqs) {
      console.log(`\n${r.method} ${r.url}`);
      console.log('Headers:');
      for (const [k, v] of Object.entries(r.headers)) {
        if (['cookie', 'sec-fetch-site', 'sec-fetch-mode', 'sec-ch-ua', 'accept-language', 'accept-encoding'].includes(k)) continue;
        let val = v;
        if (val.length > 200) val = val.slice(0, 200) + '...';
        console.log(`  ${k}: ${val}`);
      }
      if (r.body) {
        console.log(`Body: ${r.body.slice(0, 1500)}`);
      }
    }
  }

  await page.close().catch(() => {});
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
