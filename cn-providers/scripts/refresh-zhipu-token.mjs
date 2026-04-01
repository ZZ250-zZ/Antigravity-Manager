#!/usr/bin/env node
/**
 * 刷新 Zhipu token 并测试
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const cookies = await context.cookies();

  const refreshToken = cookies.find(c => c.name === 'chatglm_refresh_token')?.value;
  const accessToken = cookies.find(c => c.name === 'chatglm_token')?.value;
  const expires = cookies.find(c => c.name === 'chatglm_token_expires')?.value;

  console.log('Access Token:', accessToken?.slice(0, 30) + '...');
  console.log('Refresh Token:', refreshToken?.slice(0, 30) + '...');
  console.log('Expires:', decodeURIComponent(expires ?? ''));

  // 尝试在浏览器中刷新
  let page = context.pages().find(p => p.url().includes('chatglm'));
  if (!page) {
    page = await context.newPage();
    await page.goto('https://chatglm.cn/main/chatfree', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
  }

  // 方法1：导航到 chatglm 让它自动刷新
  console.log('\n导航到 chatglm 页面让它自动刷新 token...');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // 重新获取 cookies
  const newCookies = await context.cookies();
  const newAccessToken = newCookies.find(c => c.name === 'chatglm_token')?.value;
  const newExpires = newCookies.find(c => c.name === 'chatglm_token_expires')?.value;

  console.log('\n刷新后:');
  console.log('Access Token:', newAccessToken?.slice(0, 30) + '...');
  console.log('Expires:', decodeURIComponent(newExpires ?? ''));
  console.log('Token 变化:', newAccessToken !== accessToken ? '是' : '否');

  if (newAccessToken && newAccessToken !== accessToken) {
    console.log('\n=== 用新 token 测试 API ===');
    const result = await page.evaluate(async (token) => {
      try {
        const res = await fetch('/chatglm/backend-api/assistant/stream', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({
            assistant_id: '65940acff94777010aa6b796',
            conversation_id: '',
            project_id: '',
            chat_type: 'user_chat',
            messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
            meta_data: { cogview: { rm_label_watermark: false }, is_networking: false, input_question_type: 'xxxx', is_test: false, platform: 'pc' },
          }),
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        const chunks = [];
        let count = 0;
        while (count < 5) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const p = t.slice(5).trim();
            if (p === '[DONE]') { chunks.push('[DONE]'); continue; }
            if (!p) continue;
            count++;
            chunks.push(p.slice(0, 300));
          }
        }
        reader.releaseLock();
        return { status: res.status, chunks };
      } catch (e) {
        return { error: e.message };
      }
    }, newAccessToken);

    console.log('Status:', result.status);
    if (result.chunks) {
      for (const c of result.chunks) console.log('  Chunk:', c.slice(0, 200));
    }
    if (result.error) console.log('Error:', result.error);
  } else {
    // Token 没变，试试直接在页面上下文中用已有的认证
    console.log('\n=== Token 未变化，直接在页面上下文测试 ===');
    const result = await page.evaluate(async () => {
      try {
        const res = await fetch('/chatglm/backend-api/assistant/stream', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({
            assistant_id: '65940acff94777010aa6b796',
            conversation_id: '',
            project_id: '',
            chat_type: 'user_chat',
            messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
            meta_data: { cogview: { rm_label_watermark: false }, is_networking: false, input_question_type: 'xxxx', is_test: false, platform: 'pc' },
          }),
        });
        if (!res.ok) {
          return { status: res.status, body: await res.text() };
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        const chunks = [];
        let count = 0;
        while (count < 5) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const p = t.slice(5).trim();
            if (p === '[DONE]') { chunks.push('[DONE]'); continue; }
            if (!p) continue;
            count++;
            chunks.push(p.slice(0, 300));
          }
        }
        reader.releaseLock();
        return { status: res.status, chunks };
      } catch (e) {
        return { error: e.message };
      }
    });
    console.log('Status:', result.status);
    if (result.body) console.log('Body:', result.body?.slice(0, 300));
    if (result.chunks) {
      for (const c of result.chunks) console.log('  Chunk:', c.slice(0, 200));
    }
  }

  browser.close();
}

main().catch(e => console.error(e.message));
