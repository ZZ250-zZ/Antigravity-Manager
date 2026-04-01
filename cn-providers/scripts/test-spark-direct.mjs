#!/usr/bin/env node
/**
 * 直接测试 Spark 新 API — 使用 wreq-js 发送请求
 * 
 * 已逆向的 API:
 * 1. POST /iflygpt/u/chat-list/v1/create-chat-list → chatListId
 * 2. POST /iflygpt-chat/u/chat_message/chat → SSE
 */
import puppeteer from 'puppeteer-core';
import { httpRequest } from '../src/http-client.mjs';

const BASE_URL = 'https://xinghuo.xfyun.cn';

async function extractCookies() {
  console.log('提取 Spark cookies...');
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
  const client = await (await browser.pages())[0].createCDPSession();
  const { cookies } = await client.send('Network.getAllCookies');
  
  // 提取 xinghuo.xfyun.cn 的所有 cookies
  const sparkCookies = cookies.filter(c => c.domain.includes('xfyun.cn') || c.domain.includes('xinghuo'));
  
  // 找 ssoSessionId
  const ssoSessionId = sparkCookies.find(c => c.name === 'ssoSessionId')?.value;
  
  // 构建完整 Cookie 字符串
  const cookieStr = sparkCookies.map(c => `${c.name}=${c.value}`).join('; ');
  
  console.log('ssoSessionId:', ssoSessionId ? `${ssoSessionId.slice(0, 20)}...` : '未找到');
  console.log('Cookie 数量:', sparkCookies.length);
  
  browser.disconnect();
  return { ssoSessionId, cookieStr, cookies: sparkCookies };
}

async function main() {
  const { ssoSessionId, cookieStr } = await extractCookies();
  if (!ssoSessionId) {
    console.error('未找到 ssoSessionId，无法继续');
    return;
  }

  const commonHeaders = {
    Origin: BASE_URL,
    Referer: `${BASE_URL}/desk`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    Cookie: cookieStr,
    'Lang-Code': 'zh',
    clientType: '1',
  };

  // Step 1: 创建新对话
  console.log('\n=== Step 1: 创建对话 ===');
  const createRes = await httpRequest(`${BASE_URL}/iflygpt/u/chat-list/v1/create-chat-list`, {
    method: 'POST',
    headers: {
      ...commonHeaders,
      'Content-Type': 'application/json',
      'web-v': '0.1.0',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/plain, */*',
      Channel: '',
    },
    body: JSON.stringify({}),
  });
  const createData = await createRes.json();
  console.log('创建结果:', JSON.stringify(createData, null, 2));
  
  const chatListId = createData?.data?.id;
  if (!chatListId) {
    console.error('创建对话失败');
    return;
  }
  console.log('chatListId:', chatListId);

  // Step 2: 发送消息（使用 multipart/form-data）
  console.log('\n=== Step 2: 发送消息 ===');
  
  // 构建 multipart/form-data 手动（因为 wreq-js 可能不支持 FormData）
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);
  const fields = [
    { name: 'fd', value: String(chatListId) }, // fd 可能就是 chatId
    { name: 'isBot', value: '0' },
    { name: 'capabilities', value: '' }, // 不要联网搜索，简化响应
    { name: 'clientType', value: '1' },
    { name: 'text', value: '1+1等于几？' },
    { name: 'chatId', value: String(chatListId) },
    { name: 'options', value: JSON.stringify({ chatOption: { thinkPattern: 'auto' } }) },
    { name: 'GtToken', value: '' }, // 先尝试空 GtToken
    { name: 'clientType', value: '1' },
  ];

  const multipartBody = fields
    .map(f => `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value}`)
    .join('\r\n') + `\r\n--${boundary}--\r\n`;

  const chatRes = await httpRequest(`${BASE_URL}/iflygpt-chat/u/chat_message/chat`, {
    method: 'POST',
    headers: {
      ...commonHeaders,
      Referer: `${BASE_URL}/desk?chatId=${chatListId}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      accept: 'text/event-stream',
      Challenge: '',
      Seccode: '',
      Validate: '',
      Botweb: '0',
    },
    body: multipartBody,
  });

  console.log('Chat 响应状态:', chatRes.status);
  console.log('Content-Type:', chatRes.headers?.get?.('content-type') || 'N/A');

  if (!chatRes.ok) {
    const errText = await chatRes.text().catch(() => '');
    console.error('请求失败:', errText.slice(0, 500));
    return;
  }

  // 读取 SSE 流
  console.log('\n=== SSE 响应 ===');
  const reader = chatRes.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let rawSSE = '';
  let chunkCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    const chunk = decoder.decode(value, { stream: true });
    rawSSE += chunk;
    chunkCount++;
    
    // 前10个 chunk 打印原始数据
    if (chunkCount <= 10) {
      console.log(`[Chunk ${chunkCount}] ${JSON.stringify(chunk).slice(0, 200)}`);
    }

    // 解析 SSE 事件
    const lines = chunk.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      
      if (trimmed.startsWith('data:')) {
        const payload = trimmed.slice(5).trim();
        if (payload === '' || payload === '[DONE]') continue;
        
        try {
          const obj = JSON.parse(payload);
          // 提取文本内容
          const text = obj.content || obj.data || obj.text || '';
          if (text) {
            fullText += text;
            if (chunkCount <= 10) {
              console.log(`  解析: ${JSON.stringify(obj).slice(0, 200)}`);
            }
          }
        } catch {
          // 可能不是 JSON
          if (chunkCount <= 10) {
            console.log(`  非JSON: ${payload.slice(0, 100)}`);
          }
        }
      }
    }
  }

  console.log(`\n总 chunk 数: ${chunkCount}`);
  console.log('完整文本:', fullText.slice(0, 500));
  
  // 保存原始 SSE 数据
  const fs = await import('node:fs/promises');
  await fs.writeFile('d:\\workspace\\me\\Antigravity-Manager\\cn-providers\\debug\\spark-sse-raw.txt', rawSSE, 'utf-8');
  console.log('\n原始 SSE 数据已保存到 debug/spark-sse-raw.txt');

  // Step 3: 删除对话（测试清理 API）
  console.log('\n=== Step 3: 删除对话 ===');
  const deleteRes = await httpRequest(`${BASE_URL}/iflygpt/u/chat-list/v1/delete-chat-list`, {
    method: 'POST',
    headers: {
      ...commonHeaders,
      'Content-Type': 'application/json',
      'web-v': '0.1.0',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/plain, */*',
      Channel: '',
    },
    body: JSON.stringify({ chatListId }),
  });
  const delData = await deleteRes.json().catch(() => null);
  console.log('删除结果:', JSON.stringify(delData));

  // 如果 v1 删除失败，试 v2
  if (!delData?.flag) {
    console.log('v1 删除失败，尝试旧 API...');
    const del2 = await httpRequest(`${BASE_URL}/iflygpt-chat/u/chat_list/delete`, {
      method: 'POST',
      headers: {
        ...commonHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ chatListId }),
    });
    const del2Data = await del2.json().catch(() => null);
    console.log('旧 API 删除结果:', JSON.stringify(del2Data));
  }
}

main().catch(e => console.error('Error:', e.message));
