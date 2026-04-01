#!/usr/bin/env node
/**
 * Spark API 深度分析脚本 v2
 * 
 * 策略改进：
 * 1. 优先使用已存在的 Spark 标签页（可能已通过 GeeTest）
 * 2. 同时监控 HTTP + WebSocket 流量
 * 3. 截图观察 UI 实际状态
 * 4. 寻找发送按钮而非仅用 Enter
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

  // 查找已有的 Spark 标签页
  const pages = await browser.pages();
  let sparkPage = null;
  for (const p of pages) {
    const url = p.url();
    if (url.includes('xinghuo.xfyun.cn')) {
      sparkPage = p;
      console.log('找到已有 Spark 标签页:', url);
      break;
    }
  }

  // 如果没有已有标签页，打开新的
  if (!sparkPage) {
    console.log('未找到 Spark 标签页，新建...');
    sparkPage = await browser.newPage();
    await sparkPage.goto('https://xinghuo.xfyun.cn/desk', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await new Promise(r => setTimeout(r, 5000));
  }

  const client = await sparkPage.createCDPSession();

  // 收集数据
  const capturedRequests = [];
  const capturedResponses = [];
  const webSocketFrames = [];

  // 启用 Network 域 — 同时监控 HTTP 和 WebSocket
  await client.send('Network.enable');

  // 监听所有 HTTP 请求（不过滤，确保不遗漏）
  client.on('Network.requestWillBeSent', (params) => {
    const url = params.request.url;
    // 只记录 xfyun/geetest 相关的
    if (!url.includes('xinghuo') && !url.includes('iflygpt') && !url.includes('geetest') && !url.includes('xfyun'))
      return;
    capturedRequests.push({
      requestId: params.requestId,
      timestamp: Date.now(),
      method: params.request.method,
      url,
      headers: params.request.headers,
      postData: params.request.postData,
    });
  });

  client.on('Network.responseReceived', async (params) => {
    const url = params.response.url;
    if (!url.includes('xinghuo') && !url.includes('iflygpt') && !url.includes('geetest') && !url.includes('xfyun'))
      return;
    const resp = {
      requestId: params.requestId,
      timestamp: Date.now(),
      status: params.response.status,
      url,
      headers: params.response.headers,
      mimeType: params.response.mimeType,
    };
    try {
      const bodyResult = await client.send('Network.getResponseBody', { requestId: params.requestId });
      resp.body = bodyResult.body?.slice(0, 5000);
    } catch {}
    capturedResponses.push(resp);
  });

  // 监听 WebSocket 连接和消息
  client.on('Network.webSocketCreated', (params) => {
    console.log(`[WS-CREATED] ${params.url}`);
    webSocketFrames.push({ type: 'created', url: params.url, requestId: params.requestId, ts: Date.now() });
  });

  client.on('Network.webSocketFrameSent', (params) => {
    const data = params.response?.payloadData?.slice(0, 2000);
    console.log(`[WS-SENT] ${data?.slice(0, 200)}`);
    webSocketFrames.push({ type: 'sent', requestId: params.requestId, data, ts: Date.now() });
  });

  client.on('Network.webSocketFrameReceived', (params) => {
    const data = params.response?.payloadData?.slice(0, 2000);
    if (data) {
      console.log(`[WS-RECV] ${data.slice(0, 200)}`);
      webSocketFrames.push({ type: 'received', requestId: params.requestId, data, ts: Date.now() });
    }
  });

  client.on('Network.webSocketClosed', (params) => {
    console.log(`[WS-CLOSED] requestId=${params.requestId}`);
    webSocketFrames.push({ type: 'closed', requestId: params.requestId, ts: Date.now() });
  });

  // 等一下让 Network 事件稳定
  await new Promise(r => setTimeout(r, 2000));

  // Step 1: 截图查看当前状态
  console.log('\n=== Step 1: 截图 ===');
  await mkdir(DEBUG_DIR, { recursive: true });
  await sparkPage.screenshot({ path: `${DEBUG_DIR}/spark-page-state.png`, fullPage: false });
  console.log('截图已保存到 debug/spark-page-state.png');

  // Step 2: 分析页面结构
  console.log('\n=== Step 2: 页面分析 ===');
  const pageInfo = await sparkPage.evaluate(() => {
    // 检查是否有 GeeTest 弹窗
    const geetestOverlay = document.querySelector('.geetest_panel, .geetest_wait, .geetest_popup, .geetest_box, [class*="geetest"]');
    
    // 查找输入区域
    const textareas = Array.from(document.querySelectorAll('textarea'));
    const contentEditables = Array.from(document.querySelectorAll('[contenteditable="true"]'));
    
    // 查找发送按钮（各种可能的选择器）
    const buttons = Array.from(document.querySelectorAll('button'));
    const sendButtons = buttons.filter(b => {
      const text = b.textContent?.trim() || '';
      const className = b.className || '';
      const ariaLabel = b.getAttribute('aria-label') || '';
      return text.includes('发送') || text.includes('Send') || 
             className.includes('send') || className.includes('submit') ||
             ariaLabel.includes('发送') || ariaLabel.includes('send');
    });

    // 查找所有 SVG 图标按钮（可能是发送箭头图标）
    const svgButtons = buttons.filter(b => b.querySelector('svg'));

    // 检查页面 URL 和标题
    return {
      url: window.location.href,
      title: document.title,
      geetestOverlay: geetestOverlay ? {
        tag: geetestOverlay.tagName,
        className: geetestOverlay.className,
        visible: geetestOverlay.offsetParent !== null,
        text: geetestOverlay.textContent?.slice(0, 200),
      } : null,
      textareas: textareas.map((t, i) => ({
        index: i,
        placeholder: t.placeholder,
        value: t.value?.slice(0, 100),
        visible: t.offsetParent !== null,
        rect: t.getBoundingClientRect().toJSON(),
      })),
      contentEditables: contentEditables.map((e, i) => ({
        index: i,
        tag: e.tagName,
        className: e.className?.slice(0, 100),
        text: e.textContent?.slice(0, 100),
        visible: e.offsetParent !== null,
      })),
      sendButtons: sendButtons.map(b => ({
        text: b.textContent?.trim()?.slice(0, 50),
        className: b.className?.slice(0, 100),
        disabled: b.disabled,
        visible: b.offsetParent !== null,
        rect: b.getBoundingClientRect().toJSON(),
      })),
      svgButtonsNearBottom: svgButtons
        .filter(b => b.getBoundingClientRect().top > window.innerHeight * 0.5)
        .map(b => ({
          className: b.className?.slice(0, 100),
          title: b.title || b.getAttribute('aria-label') || '',
          disabled: b.disabled,
          rect: b.getBoundingClientRect().toJSON(),
          parentClass: b.parentElement?.className?.slice(0, 100),
        })),
      totalButtons: buttons.length,
      totalSvgButtons: svgButtons.length,
    };
  });

  console.log('URL:', pageInfo.url);
  console.log('标题:', pageInfo.title);
  console.log('GeeTest 弹窗:', pageInfo.geetestOverlay ? JSON.stringify(pageInfo.geetestOverlay) : '无');
  console.log('Textarea:', JSON.stringify(pageInfo.textareas, null, 2));
  console.log('ContentEditable:', JSON.stringify(pageInfo.contentEditables, null, 2));
  console.log('发送按钮:', JSON.stringify(pageInfo.sendButtons, null, 2));
  console.log(`底部 SVG 按钮(${pageInfo.svgButtonsNearBottom.length}):`,
    JSON.stringify(pageInfo.svgButtonsNearBottom, null, 2));
  console.log(`总按钮: ${pageInfo.totalButtons}, SVG按钮: ${pageInfo.totalSvgButtons}`);

  // Step 3: 检查现有 WebSocket 连接
  console.log('\n=== Step 3: 检查 WebSocket ===');
  const wsInfo = await sparkPage.evaluate(() => {
    // 尝试检测页面上的 WebSocket 实例
    // 注：这只能检测到暴露在全局作用域的 WS
    const wsKeys = Object.keys(window).filter(k => {
      try { return window[k] instanceof WebSocket; } catch { return false; }
    });
    return {
      wsKeys,
      perfEntries: performance.getEntriesByType('resource')
        .filter(e => e.name.includes('ws://') || e.name.includes('wss://'))
        .map(e => ({ name: e.name, type: e.initiatorType }))
    };
  });
  console.log('WebSocket 实例:', wsInfo.wsKeys);
  console.log('WS 资源条目:', JSON.stringify(wsInfo.perfEntries));

  // Step 4: 尝试用 page.evaluate 方式 hook 住 WebSocket 和 fetch
  console.log('\n=== Step 4: Hook fetch/XHR/WebSocket ===');
  await sparkPage.evaluate(() => {
    // Hook fetch
    const origFetch = window.fetch;
    window.fetch = function(...args) {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (url && (url.includes('chat') || url.includes('send') || url.includes('ask') || url.includes('completions'))) {
        console.log(`[HOOKED-FETCH] ${args[1]?.method || 'GET'} ${url}`);
        console.log('[HOOKED-FETCH-BODY]', JSON.stringify(args[1]?.body)?.slice(0, 500));
      }
      return origFetch.apply(this, args);
    };

    // Hook XMLHttpRequest
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this._hookUrl = url;
      this._hookMethod = method;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(body) {
      if (this._hookUrl && (this._hookUrl.includes('chat') || this._hookUrl.includes('send') || this._hookUrl.includes('ask'))) {
        console.log(`[HOOKED-XHR] ${this._hookMethod} ${this._hookUrl}`);
        console.log('[HOOKED-XHR-BODY]', typeof body === 'string' ? body.slice(0, 500) : '(non-string)');
      }
      return origSend.apply(this, arguments);
    };

    // Hook WebSocket
    const OrigWS = window.WebSocket;
    window.WebSocket = function(url, protocols) {
      console.log(`[HOOKED-WS-CONNECT] ${url}`);
      const ws = new OrigWS(url, protocols);
      const origWsSend = ws.send.bind(ws);
      ws.send = function(data) {
        console.log(`[HOOKED-WS-SEND] ${typeof data === 'string' ? data.slice(0, 200) : '(binary)'}`);
        return origWsSend(data);
      };
      ws.addEventListener('message', (e) => {
        const d = typeof e.data === 'string' ? e.data.slice(0, 200) : '(binary)';
        console.log(`[HOOKED-WS-RECV] ${d}`);
      });
      return ws;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.CONNECTING = OrigWS.CONNECTING;
    window.WebSocket.OPEN = OrigWS.OPEN;
    window.WebSocket.CLOSING = OrigWS.CLOSING;
    window.WebSocket.CLOSED = OrigWS.CLOSED;

    window.__sparkHooked = true;
  });
  console.log('Hook 已安装');

  // 监听 console 消息以捕获 hook 输出
  sparkPage.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[HOOKED-')) {
      console.log('  >> ' + text);
    }
  });

  // Step 5: 输入消息并寻找发送按钮
  console.log('\n=== Step 5: 输入消息 ===');
  const reqCountBefore = capturedRequests.length;

  // 寻找可见的 textarea
  const visibleTextarea = pageInfo.textareas.find(t => t.visible && t.rect.width > 100);
  if (visibleTextarea) {
    console.log(`使用 textarea[${visibleTextarea.index}]`, visibleTextarea.placeholder);
    
    // 点击并输入
    const ta = (await sparkPage.$$('textarea'))[visibleTextarea.index];
    await ta.click();
    await new Promise(r => setTimeout(r, 300));

    // 清除已有内容
    await sparkPage.keyboard.down('Control');
    await sparkPage.keyboard.press('KeyA');
    await sparkPage.keyboard.up('Control');
    await sparkPage.keyboard.press('Backspace');
    await new Promise(r => setTimeout(r, 200));

    // 输入自然问题
    await ta.type('请帮我解释一下光合作用的基本原理', { delay: 50 });
    await new Promise(r => setTimeout(r, 1000));

    // 截图看输入后状态
    await sparkPage.screenshot({ path: `${DEBUG_DIR}/spark-after-input.png`, fullPage: false });
    console.log('输入后截图已保存');

    // 再次检查 UI 状态（发送按钮可能变为可用）
    const afterInputInfo = await sparkPage.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      // 查找底部区域可能的发送按钮
      const bottomButtons = buttons.filter(b => {
        const r = b.getBoundingClientRect();
        return r.top > window.innerHeight * 0.3 && r.width > 10;
      });
      return bottomButtons.map(b => ({
        text: b.textContent?.trim()?.slice(0, 50),
        className: b.className?.slice(0, 100),
        disabled: b.disabled,
        rect: b.getBoundingClientRect().toJSON(),
        hasSvg: !!b.querySelector('svg'),
        ariaLabel: b.getAttribute('aria-label') || '',
      }));
    });
    console.log('输入后底部按钮:', JSON.stringify(afterInputInfo, null, 2));

    // 尝试找发送按钮并点击
    let sendClicked = false;
    for (const btnInfo of afterInputInfo) {
      const isSend = btnInfo.text.includes('发送') || btnInfo.ariaLabel.includes('发送') ||
        btnInfo.className.includes('send') || btnInfo.className.includes('submit');
      if (isSend && !btnInfo.disabled) {
        console.log('找到发送按钮，点击:', btnInfo.text || btnInfo.className);
        await sparkPage.click(`button.${btnInfo.className.split(' ')[0]}`).catch(() => null);
        sendClicked = true;
        break;
      }
    }

    if (!sendClicked) {
      // 回退：用 Enter 发送
      console.log('未找到发送按钮，尝试 Enter...');
      await sparkPage.keyboard.press('Enter');
    }

    // 等待网络活动
    console.log('等待 API 响应 (20s)...');
    await new Promise(r => setTimeout(r, 20000));

    // 打印新增请求
    const newRequests = capturedRequests.slice(reqCountBefore);
    console.log(`\n发送后新增 ${newRequests.length} 个请求`);
    
    // 重点关注非页面加载的请求
    const chatRelated = newRequests.filter(r => 
      r.url.includes('chat') || r.url.includes('send') || r.url.includes('ask') ||
      r.url.includes('completions') || r.url.includes('message') ||
      r.method === 'POST'
    );
    console.log(`\n聊天相关 POST 请求 (${chatRelated.length}):`);
    for (const req of chatRelated) {
      console.log(`  ${req.method} ${req.url}`);
      if (req.postData) console.log(`    Body: ${req.postData.slice(0, 500)}`);
    }

    // 打印 WebSocket 活动
    console.log(`\nWebSocket 帧 (${webSocketFrames.length}):`);
    for (const f of webSocketFrames) {
      console.log(`  [${f.type}] ${f.url || f.data?.slice(0, 200) || ''}`);
    }

    // 截图最终状态
    await sparkPage.screenshot({ path: `${DEBUG_DIR}/spark-after-send.png`, fullPage: false });
    console.log('发送后截图已保存');
  } else {
    console.log('未找到可见 textarea！');
  }

  // 保存所有捕获数据
  const result = {
    requests: capturedRequests,
    responses: capturedResponses,
    webSocketFrames,
    pageInfo,
  };
  await writeFile(`${DEBUG_DIR}/spark-capture-v2.json`, JSON.stringify(result, null, 2), 'utf-8');
  console.log('\n数据已保存到 debug/spark-capture-v2.json');

  browser.disconnect();
}

main().catch(e => console.error('Error:', e.message, e.stack));
