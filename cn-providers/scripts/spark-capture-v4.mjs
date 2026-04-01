#!/usr/bin/env node
/**
 * Spark API 分析脚本 v4 — 使用纯 JS evaluate 操作，避免 puppeteer 高级方法卡住
 * 
 * 关键策略：
 * 1. 用 page.evaluate 直接操作 DOM
 * 2. 用 React 内部机制设置 textarea 值
 * 3. 通过 JS 触发发送按钮点击
 * 4. 全面监控 HTTP + WebSocket
 */
import puppeteer from 'puppeteer-core';
import { writeFile, mkdir } from 'node:fs/promises';

const DEBUG_DIR = 'd:\\workspace\\me\\Antigravity-Manager\\cn-providers\\debug';

async function main() {
  console.log('连接 CDP...');
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null,
  });

  const pages = await browser.pages();
  let page = pages.find(p => p.url().includes('xinghuo.xfyun.cn'));
  if (!page) {
    console.log('未找到 Spark 标签页，新建...');
    page = await browser.newPage();
    await page.goto('https://xinghuo.xfyun.cn/desk', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));
  } else {
    console.log('使用已有标签页:', page.url());
  }

  const client = await page.createCDPSession();
  await client.send('Network.enable');

  const allTraffic = [];

  // 监听所有流量
  client.on('Network.requestWillBeSent', (p) => {
    allTraffic.push({ type: 'req', method: p.request.method, url: p.request.url, postData: p.request.postData?.slice(0, 3000), headers: p.request.headers, ts: Date.now(), reqId: p.requestId });
  });
  client.on('Network.responseReceived', async (p) => {
    let body = '';
    try { body = (await client.send('Network.getResponseBody', { requestId: p.requestId })).body?.slice(0, 5000) || ''; } catch {}
    allTraffic.push({ type: 'resp', url: p.response.url, status: p.response.status, mimeType: p.response.mimeType, body, headers: p.response.headers, ts: Date.now(), reqId: p.requestId });
  });
  // 事件流数据（SSE / chunked 传输的接收）
  client.on('Network.dataReceived', (p) => {
    allTraffic.push({ type: 'data', reqId: p.requestId, dataLength: p.dataLength, ts: Date.now() });
  });
  // WebSocket
  client.on('Network.webSocketCreated', (p) => {
    console.log(`[WS-OPEN] ${p.url}`);
    allTraffic.push({ type: 'ws-open', url: p.url, reqId: p.requestId, ts: Date.now() });
  });
  client.on('Network.webSocketFrameSent', (p) => {
    const d = p.response?.payloadData || '';
    if (d !== 'PING') console.log(`[WS-SEND] ${d.slice(0, 300)}`);
    allTraffic.push({ type: 'ws-send', data: d.slice(0, 5000), reqId: p.requestId, ts: Date.now() });
  });
  client.on('Network.webSocketFrameReceived', (p) => {
    const d = p.response?.payloadData || '';
    if (d !== 'PONG' && d !== 'PING') console.log(`[WS-RECV] ${d.slice(0, 300)}`);
    allTraffic.push({ type: 'ws-recv', data: d.slice(0, 5000), reqId: p.requestId, ts: Date.now() });
  });

  await new Promise(r => setTimeout(r, 1000));
  const trafficBefore = allTraffic.length;

  // Step 1: 用 JS 操作 DOM — 输入文字并触发 React onChange
  console.log('\n=== Step 1: 用 JS 输入消息 ===');
  const inputResult = await page.evaluate(() => {
    // 找到可见 textarea
    const tas = Array.from(document.querySelectorAll('textarea'));
    const visTA = tas.find(t => t.offsetParent !== null && t.getBoundingClientRect().width > 100);
    if (!visTA) return { error: '未找到可见 textarea' };

    // React 16+ 使用内部属性跟踪值，需要使用 nativeInputValueSetter 方式
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    nativeInputValueSetter.call(visTA, '请帮我解释一下光合作用的基本原理');
    
    // 触发 React 的 onChange
    visTA.dispatchEvent(new Event('input', { bubbles: true }));
    visTA.dispatchEvent(new Event('change', { bubbles: true }));

    // 检查发送按钮状态
    const sendBtn = document.querySelector('[class*="AskWindow_send"]');
    const sendBtnClass = sendBtn?.className || '';
    const isDisabled = sendBtnClass.includes('Disabled');

    return {
      success: true,
      value: visTA.value?.slice(0, 50),
      sendBtnClass,
      isDisabled,
      sendBtnRect: sendBtn?.getBoundingClientRect().toJSON(),
    };
  });
  console.log('输入结果:', JSON.stringify(inputResult, null, 2));

  // 等一下让 React 处理
  await new Promise(r => setTimeout(r, 1000));

  // 再检查发送按钮状态
  const sendStatus = await page.evaluate(() => {
    const sendBtn = document.querySelector('[class*="AskWindow_send"]');
    return {
      className: sendBtn?.className,
      isDisabled: sendBtn?.className?.includes('Disabled'),
      rect: sendBtn?.getBoundingClientRect().toJSON(),
    };
  });
  console.log('发送按钮状态:', JSON.stringify(sendStatus, null, 2));

  // 截图看当前状态
  await mkdir(DEBUG_DIR, { recursive: true });
  await page.screenshot({ path: `${DEBUG_DIR}/spark-v4-input.png`, fullPage: false });
  console.log('输入后截图已保存');

  // Step 2: 如果按钮还是禁用的，尝试 focus + keyboard 事件
  if (sendStatus.isDisabled) {
    console.log('\n发送按钮仍为禁用，尝试通过键盘事件触发...');
    await page.evaluate(() => {
      const ta = Array.from(document.querySelectorAll('textarea')).find(t => t.offsetParent !== null && t.getBoundingClientRect().width > 100);
      if (!ta) return;

      // 聚焦
      ta.focus();
      
      // 触发完整的键盘事件序列
      const text = '请帮我解释一下光合作用的基本原理';
      for (const char of text) {
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
        ta.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
        ta.dispatchEvent(new InputEvent('input', { data: char, inputType: 'insertText', bubbles: true }));
        ta.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
      }
    });
    await new Promise(r => setTimeout(r, 1000));

    // 再次检查
    const sendStatus2 = await page.evaluate(() => {
      const sendBtn = document.querySelector('[class*="AskWindow_send"]');
      const ta = Array.from(document.querySelectorAll('textarea')).find(t => t.offsetParent !== null);
      return {
        className: sendBtn?.className,
        isDisabled: sendBtn?.className?.includes('Disabled'),
        textareaValue: ta?.value?.slice(0, 50),
      };
    });
    console.log('重试后发送按钮状态:', JSON.stringify(sendStatus2, null, 2));
  }

  // Step 3: 尝试点击发送按钮
  console.log('\n=== Step 2: 点击发送按钮 ===');
  
  // 方式1: 直接通过 evaluate 触发 click
  const clickResult = await page.evaluate(() => {
    const sendBtn = document.querySelector('[class*="AskWindow_send"]');
    if (!sendBtn) return { error: '未找到发送按钮' };
    
    // 强制移除 disabled 样式（尝试）
    sendBtn.className = sendBtn.className.replace(/AskWindow_sendDisabled\w*/g, '');
    
    // 触发点击事件
    sendBtn.click();
    sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    return { clicked: true, newClass: sendBtn.className };
  });
  console.log('点击结果:', JSON.stringify(clickResult));

  // 等待网络活动
  console.log('\n等待响应 (20s)...');
  await new Promise(r => setTimeout(r, 20000));

  // Step 4: 分析新增流量
  const newTraffic = allTraffic.slice(trafficBefore);
  console.log(`\n=== 新增流量 (${newTraffic.length}) ===`);

  // 过滤出关键流量
  for (const t of newTraffic) {
    if (t.type === 'req' && t.method === 'POST') {
      console.log(`\n[POST] ${t.url}`);
      if (t.postData) console.log(`  Body: ${t.postData.slice(0, 500)}`);
      console.log(`  Headers: ${JSON.stringify(Object.fromEntries(Object.entries(t.headers).filter(([k]) => !['Accept-Language', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'User-Agent'].includes(k))), null, 2)}`);
    } else if (t.type === 'resp' && (t.mimeType?.includes('event-stream') || t.url?.includes('chat') || t.url?.includes('send'))) {
      console.log(`[RESP] ${t.status} ${t.url} (${t.mimeType})`);
      if (t.body) console.log(`  Body: ${t.body.slice(0, 500)}`);
    } else if (t.type === 'ws-open') {
      console.log(`[WS-OPEN] ${t.url}`);
    } else if (t.type === 'ws-send' && t.data !== 'PING') {
      console.log(`[WS-SEND] ${t.data.slice(0, 500)}`);
    } else if (t.type === 'ws-recv' && t.data !== 'PONG' && t.data !== 'PING') {
      console.log(`[WS-RECV] ${t.data.slice(0, 500)}`);
    }
  }

  // 截图最终状态
  await page.screenshot({ path: `${DEBUG_DIR}/spark-v4-after.png`, fullPage: false });
  console.log('\n发送后截图已保存');

  // 保存数据
  await writeFile(`${DEBUG_DIR}/spark-traffic-v4.json`, JSON.stringify(allTraffic, null, 2), 'utf-8');
  console.log('数据已保存到 debug/spark-traffic-v4.json');

  browser.disconnect();
}

main().catch(e => console.error('Error:', e.message));
