#!/usr/bin/env node
/**
 * Spark API 深度分析脚本 v3
 * 
 * 根据截图分析：
 * - 发送按钮是输入框右侧的绿色圆形按钮
 * - 页面已有活跃 WebSocket (PING/PONG)
 * - 重点监控 WebSocket 流量 + 所有非 GET 的 HTTP 请求
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
  let page = null;
  for (const p of pages) {
    if (p.url().includes('xinghuo.xfyun.cn')) {
      page = p;
      console.log('使用已有标签页:', p.url());
      break;
    }
  }
  if (!page) {
    console.log('未找到 Spark 标签页');
    browser.disconnect();
    return;
  }

  const client = await page.createCDPSession();
  await client.send('Network.enable');

  // 收集数据
  const allTraffic = [];

  // 监听所有 HTTP 请求
  client.on('Network.requestWillBeSent', (params) => {
    const { method, url, postData, headers } = params.request;
    allTraffic.push({ type: 'http-req', method, url, postData: postData?.slice(0, 3000), headers, ts: Date.now() });
    if (method === 'POST' || url.includes('chat') || url.includes('send') || url.includes('ask')) {
      console.log(`[HTTP] ${method} ${url}`);
      if (postData) console.log(`  Body: ${postData.slice(0, 300)}`);
    }
  });

  client.on('Network.responseReceived', async (params) => {
    const { url, status, mimeType, headers } = params.response;
    let body = '';
    try {
      const r = await client.send('Network.getResponseBody', { requestId: params.requestId });
      body = r.body?.slice(0, 5000) || '';
    } catch {}
    allTraffic.push({ type: 'http-resp', url, status, mimeType, body, ts: Date.now() });
    if (mimeType?.includes('event-stream') || url.includes('chat') || url.includes('send')) {
      console.log(`[HTTP-RESP] ${status} ${url} (${mimeType})`);
      if (body) console.log(`  Body: ${body.slice(0, 300)}`);
    }
  });

  // 重点: WebSocket 监控
  client.on('Network.webSocketCreated', (p) => {
    console.log(`[WS-OPEN] ${p.url}`);
    allTraffic.push({ type: 'ws-open', url: p.url, reqId: p.requestId, ts: Date.now() });
  });
  client.on('Network.webSocketFrameSent', (p) => {
    const d = p.response?.payloadData || '';
    if (d !== 'PING' && d.length > 0) {
      console.log(`[WS-SEND] ${d.slice(0, 500)}`);
    }
    allTraffic.push({ type: 'ws-send', data: d.slice(0, 5000), reqId: p.requestId, ts: Date.now() });
  });
  client.on('Network.webSocketFrameReceived', (p) => {
    const d = p.response?.payloadData || '';
    if (d !== 'PONG' && d !== 'PING' && d.length > 0) {
      console.log(`[WS-RECV] ${d.slice(0, 500)}`);
    }
    allTraffic.push({ type: 'ws-recv', data: d.slice(0, 5000), reqId: p.requestId, ts: Date.now() });
  });

  await new Promise(r => setTimeout(r, 1000));

  // Step 1: 分析输入区域和发送按钮的精确信息
  console.log('\n=== 分析 UI 元素 ===');
  const uiInfo = await page.evaluate(() => {
    // 获取输入框信息
    const textareas = Array.from(document.querySelectorAll('textarea'));
    const visibleTA = textareas.find(t => t.offsetParent !== null && t.getBoundingClientRect().width > 100);
    
    // 获取所有可点击元素（包括 div, span, svg）在输入区域附近
    const taRect = visibleTA?.getBoundingClientRect();
    const allElements = Array.from(document.querySelectorAll('*'));
    
    // 查找输入框右侧的可点击元素
    const nearbyClickables = [];
    if (taRect) {
      for (const el of allElements) {
        const r = el.getBoundingClientRect();
        // 在 textarea 右侧且垂直位置相近
        if (r.left >= taRect.right - 100 && r.left <= taRect.right + 200 &&
            Math.abs(r.top - taRect.top) < 100 &&
            r.width > 5 && r.width < 100 && r.height > 5) {
          nearbyClickables.push({
            tag: el.tagName,
            className: (el.className && typeof el.className === 'string') ? el.className.slice(0, 150) : '',
            id: el.id,
            text: el.textContent?.trim()?.slice(0, 50),
            rect: r.toJSON(),
            cursor: window.getComputedStyle(el).cursor,
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label'),
            onclick: !!el.onclick,
            hasSvg: !!el.querySelector('svg'),
          });
        }
      }
    }

    return {
      visibleTA: visibleTA ? {
        placeholder: visibleTA.placeholder,
        value: visibleTA.value?.slice(0, 100),
        rect: visibleTA.getBoundingClientRect().toJSON(),
      } : null,
      nearbyClickables,
    };
  });

  console.log('输入框:', JSON.stringify(uiInfo.visibleTA, null, 2));
  console.log(`输入区域附近可点击元素 (${uiInfo.nearbyClickables.length}):`);
  for (const el of uiInfo.nearbyClickables) {
    console.log(`  ${el.tag} class="${el.className}" cursor=${el.cursor} role=${el.role} svg=${el.hasSvg} rect=${JSON.stringify(el.rect)}`);
  }

  // Step 2: 在输入框中输入消息
  console.log('\n=== 输入消息 ===');
  if (uiInfo.visibleTA) {
    const ta = await page.$('textarea:not([style*="display: none"])');
    // 使用 evaluate 找到可见的 textarea
    const visibleTAs = await page.$$('textarea');
    let targetTA = null;
    for (const t of visibleTAs) {
      const box = await t.boundingBox();
      if (box && box.width > 100) {
        targetTA = t;
        break;
      }
    }

    if (targetTA) {
      await targetTA.click();
      await new Promise(r => setTimeout(r, 300));
      
      // 清除内容
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await new Promise(r => setTimeout(r, 200));

      await targetTA.type('请帮我解释一下光合作用的基本原理', { delay: 40 });
      console.log('消息已输入');
      await new Promise(r => setTimeout(r, 1000));

      // 输入后再次分析按钮状态（发送按钮可能变亮）
      const postInputUI = await page.evaluate(() => {
        const taRect = (() => {
          const tas = document.querySelectorAll('textarea');
          for (const t of tas) {
            if (t.offsetParent && t.getBoundingClientRect().width > 100) return t.getBoundingClientRect();
          }
          return null;
        })();
        if (!taRect) return [];

        // 扫描右侧所有元素
        const result = [];
        const walk = (el) => {
          const r = el.getBoundingClientRect();
          if (r.left >= taRect.right - 100 && r.left <= taRect.right + 200 &&
              Math.abs(r.top - taRect.top) < 100 && r.width >= 5 && r.height >= 5) {
            const style = window.getComputedStyle(el);
            result.push({
              tag: el.tagName,
              className: (typeof el.className === 'string') ? el.className.slice(0, 100) : '',
              rect: r.toJSON(),
              cursor: style.cursor,
              bgColor: style.backgroundColor,
              opacity: style.opacity,
              pointerEvents: style.pointerEvents,
            });
          }
          for (const c of el.children) walk(c);
        };
        walk(document.body);
        return result;
      });
      
      // 找有 cursor:pointer 或 bgColor 的元素（可能是发送按钮）
      const sendCandidates = postInputUI.filter(e => 
        e.cursor === 'pointer' || e.bgColor.includes('rgb')
      );
      console.log(`发送按钮候选 (${sendCandidates.length}):`);
      for (const c of sendCandidates) {
        console.log(`  ${c.tag} class="${c.className}" cursor=${c.cursor} bg=${c.bgColor} rect=(${Math.round(c.rect.x)},${Math.round(c.rect.y)},${Math.round(c.rect.width)}x${Math.round(c.rect.height)})`);
      }

      // Step 3: 截图看输入状态
      await mkdir(DEBUG_DIR, { recursive: true });
      await page.screenshot({ path: `${DEBUG_DIR}/spark-v3-input.png`, fullPage: false });
      console.log('输入后截图已保存');

      // Step 4: 标记当前流量位置
      const trafficBefore = allTraffic.length;
      
      // 尝试点击发送按钮
      // 从截图看，发送按钮在 textarea 右端，是个绿色圆形按钮
      // textarea rect: x=473, y=240, w=794, h=50
      // 发送按钮大约在 x=1267+附近，y=265 附近（textarea 中间高度）
      const sendX = uiInfo.visibleTA.rect.right + 15; // textarea 右边缘再往右一点
      const sendY = uiInfo.visibleTA.rect.top + uiInfo.visibleTA.rect.height / 2;
      
      console.log(`\n=== 点击发送按钮 (${Math.round(sendX)}, ${Math.round(sendY)}) ===`);
      await page.mouse.click(sendX, sendY);
      
      // 等待网络活动
      console.log('等待响应 (25s)...');
      await new Promise(r => setTimeout(r, 25000));

      // 打印发送后新增的所有流量
      const newTraffic = allTraffic.slice(trafficBefore);
      console.log(`\n=== 发送后新增流量 (${newTraffic.length}) ===`);
      for (const t of newTraffic) {
        if (t.type === 'ws-send' && t.data !== 'PING') {
          console.log(`[WS-SEND] ${t.data.slice(0, 500)}`);
        } else if (t.type === 'ws-recv' && t.data !== 'PONG' && t.data !== 'PING') {
          console.log(`[WS-RECV] ${t.data.slice(0, 500)}`);
        } else if (t.type === 'ws-open') {
          console.log(`[WS-OPEN] ${t.url}`);
        } else if (t.type === 'http-req' && (t.method === 'POST' || t.url.includes('chat') || t.url.includes('send'))) {
          console.log(`[HTTP] ${t.method} ${t.url}`);
          if (t.postData) console.log(`  Body: ${t.postData.slice(0, 500)}`);
        } else if (t.type === 'http-resp' && (t.mimeType?.includes('event-stream') || t.url?.includes('chat') || t.url?.includes('send'))) {
          console.log(`[HTTP-RESP] ${t.status} ${t.url}`);
          if (t.body) console.log(`  Body: ${t.body.slice(0, 500)}`);
        }
      }

      // 截图最终状态
      await page.screenshot({ path: `${DEBUG_DIR}/spark-v3-after.png`, fullPage: false });
      console.log('\n发送后截图已保存');
    }
  }

  // 保存完整数据
  await writeFile(`${DEBUG_DIR}/spark-traffic-v3.json`, JSON.stringify(allTraffic, null, 2), 'utf-8');
  console.log('完整流量数据已保存到 debug/spark-traffic-v3.json');

  browser.disconnect();
}

main().catch(e => console.error('Error:', e.message));
