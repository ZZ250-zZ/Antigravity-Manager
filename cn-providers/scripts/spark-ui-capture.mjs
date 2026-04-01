#!/usr/bin/env node
/**
 * 通过 puppeteer-core 操作 Spark UI 并捕获聊天 API 请求
 * 1. 导航到 /desk 页面
 * 2. 找到输入框，输入消息
 * 3. 使用 CDP Fetch 域拦截所有请求
 * 4. 发送消息并捕获实际的 API 调用
 */
import puppeteer from 'puppeteer-core';
import { writeFile, mkdir } from 'node:fs/promises';

async function main() {
  console.log('连接 CDP...');
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null,
  });
  console.log('已连接');
  
  const page = await browser.newPage();
  const client = await page.createCDPSession();
  
  // 启用 Fetch 域拦截（拦截所有请求并记录）
  const capturedRequests = [];
  const capturedResponses = [];
  
  // 使用 Network 域监听请求
  await client.send('Network.enable');
  
  client.on('Network.requestWillBeSent', (params) => {
    const url = params.request.url;
    if (url.includes('iflygpt') || url.includes('chat') || url.includes('send') || url.includes('gee')) {
      capturedRequests.push({
        requestId: params.requestId,
        timestamp: Date.now(),
        method: params.request.method,
        url: params.request.url,
        headers: params.request.headers,
        postData: params.request.postData,
      });
      console.log(`[REQ] ${params.request.method} ${url}`);
      if (params.request.postData) {
        console.log(`  Body: ${params.request.postData.slice(0, 500)}`);
      }
    }
  });
  
  client.on('Network.responseReceived', async (params) => {
    const url = params.response.url;
    if (url.includes('iflygpt') || url.includes('chat') || url.includes('send') || url.includes('gee')) {
      const resp = {
        requestId: params.requestId,
        timestamp: Date.now(),
        status: params.response.status,
        url: params.response.url,
        headers: params.response.headers,
        mimeType: params.response.mimeType,
      };
      
      // 尝试获取响应体
      try {
        const bodyResult = await client.send('Network.getResponseBody', { requestId: params.requestId });
        resp.body = bodyResult.body?.slice(0, 3000);
        resp.base64Encoded = bodyResult.base64Encoded;
      } catch {}
      
      capturedResponses.push(resp);
      console.log(`[RESP] ${params.response.status} ${url}`);
      if (resp.body) {
        console.log(`  Body: ${resp.body.slice(0, 500)}`);
      }
    }
  });
  
  // 导航到 Spark desk
  console.log('\n导航到 /desk...');
  await page.goto('https://xinghuo.xfyun.cn/desk', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 5000));
  
  console.log('当前 URL:', page.url());
  
  // 查找输入框
  console.log('\n=== 查找输入框 ===');
  const textareas = await page.$$('textarea');
  console.log(`找到 ${textareas.length} 个 textarea`);
  
  for (let i = 0; i < textareas.length; i++) {
    const ta = textareas[i];
    const box = await ta.boundingBox();
    const placeholder = await ta.evaluate(el => el.placeholder);
    const visible = box && box.width > 0 && box.height > 0;
    console.log(`  [${i}] placeholder="${placeholder}" visible=${visible} box=${JSON.stringify(box)}`);
  }
  
  // 查找可见的输入框
  let inputArea = null;
  for (const ta of textareas) {
    const box = await ta.boundingBox();
    if (box && box.width > 50 && box.height > 20) {
      inputArea = ta;
      break;
    }
  }
  
  if (!inputArea) {
    // 也检查 contenteditable 和其他输入元素
    const editables = await page.$$('[contenteditable="true"]');
    console.log(`找到 ${editables.length} 个 contenteditable`);
    for (const e of editables) {
      const box = await e.boundingBox();
      if (box && box.width > 50) {
        inputArea = e;
        break;
      }
    }
  }
  
  if (inputArea) {
    console.log('\n=== 发送消息 ===');
    const reqCountBefore = capturedRequests.length;
    
    // 点击输入框
    await inputArea.click();
    await new Promise(r => setTimeout(r, 500));
    
    // 输入消息（使用自然问题）
    await inputArea.type('帮我计算 123 加 456 等于多少', { delay: 30 });
    await new Promise(r => setTimeout(r, 500));
    
    console.log('消息已输入，按 Enter 发送...');
    await page.keyboard.press('Enter');
    
    // 等待响应
    console.log('等待响应...');
    await new Promise(r => setTimeout(r, 15000));
    
    // 打印新增请求
    const newRequests = capturedRequests.slice(reqCountBefore);
    console.log(`\n发送后新增 ${newRequests.length} 个请求`);
    for (const req of newRequests) {
      console.log(`\n  [REQ] ${req.method} ${req.url}`);
      if (req.postData) console.log(`  Body: ${req.postData.slice(0, 800)}`);
      console.log(`  Headers:`, JSON.stringify(req.headers, null, 4));
    }
    
    // 查看是否有对应响应
    for (const resp of capturedResponses) {
      if (newRequests.some(r => r.requestId === resp.requestId)) {
        console.log(`\n  [RESP] ${resp.status} ${resp.url}`);
        if (resp.body) console.log(`  Body: ${resp.body.slice(0, 1000)}`);
      }
    }
  } else {
    console.log('\n未找到输入框！');
    
    // 截图看当前页面
    const screenshot = await page.screenshot({ encoding: 'base64' });
    console.log('页面截图 base64 长度:', screenshot.length);
  }
  
  // 保存捕获数据
  await mkdir('d:\\workspace\\me\\Antigravity-Manager\\cn-providers\\debug', { recursive: true });
  await writeFile(
    'd:\\workspace\\me\\Antigravity-Manager\\cn-providers\\debug\\spark-ui-requests.json',
    JSON.stringify({ requests: capturedRequests, responses: capturedResponses }, null, 2),
    'utf-8'
  );
  console.log('\n请求数据已保存到 debug/spark-ui-requests.json');
  
  await page.close();
  browser.disconnect();
}

main().catch(e => console.error('Error:', e.message));
