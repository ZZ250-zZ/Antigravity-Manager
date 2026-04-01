#!/usr/bin/env node
/**
 * 在 Spark 中实际发送消息并捕获完整请求流
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const page = await context.newPage();

  // 收集所有请求
  const allRequests = [];
  page.on('request', req => {
    const url = req.url();
    if (url.includes('xinghuo') || url.includes('xfyun') || url.includes('geetest')) {
      const headers = req.headers();
      let postData = null;
      try { postData = req.postData(); } catch {}
      allRequests.push({
        time: Date.now(),
        method: req.method(),
        url,
        headers: Object.fromEntries(
          Object.entries(headers).filter(([k]) => 
            ['content-type', 'cookie', 'authorization', 'accept', 'origin', 'referer', 'x-'].some(p => k.startsWith(p))
          )
        ),
        postData: postData?.slice(0, 2000),
      });
    }
  });

  const allResponses = [];
  page.on('response', async resp => {
    const url = resp.url();
    if ((url.includes('chat') || url.includes('send') || url.includes('gee') || url.includes('captcha')) && 
        (url.includes('xinghuo') || url.includes('xfyun') || url.includes('geetest'))) {
      try {
        const ct = resp.headers()['content-type'] || '';
        let body = '';
        if (!ct.includes('image') && !ct.includes('font')) {
          body = await resp.text().catch(() => '');
        }
        allResponses.push({
          time: Date.now(),
          status: resp.status(),
          url,
          contentType: ct,
          body: body.slice(0, 3000),
        });
      } catch {}
    }
  });

  console.log('导航到 /desk ...');
  await page.goto('https://xinghuo.xfyun.cn/desk', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // 查找输入框
  console.log('\n=== 查找输入框 ===');
  const inputInfo = await page.evaluate(() => {
    const selectors = [
      'textarea',
      'input[type="text"]',
      '[contenteditable="true"]',
      '.chat-input',
      '.input-area',
      '#input',
      '.el-textarea__inner',
      '.ant-input',
    ];
    const found = [];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        found.push({
          selector: sel,
          tag: el.tagName,
          class: el.className?.slice(0, 100),
          id: el.id,
          placeholder: el.placeholder || el.getAttribute('placeholder') || '',
          visible: el.offsetParent !== null,
          rect: el.getBoundingClientRect(),
        });
      }
    }
    return found;
  });
  
  for (const inp of inputInfo) {
    console.log(`  ${inp.selector}: tag=${inp.tag} class="${inp.class}" placeholder="${inp.placeholder}" visible=${inp.visible}`);
    console.log(`    rect: top=${inp.rect.top} left=${inp.rect.left} width=${inp.rect.width} height=${inp.rect.height}`);
  }

  // 尝试输入消息
  const textarea = inputInfo.find(i => i.visible && (i.tag === 'TEXTAREA' || i.placeholder));
  if (textarea) {
    console.log(`\n使用输入框: ${textarea.selector}`);
    
    // 点击输入框
    try {
      await page.click(textarea.selector, { timeout: 5000 });
      await page.waitForTimeout(500);
      
      // 输入内容
      await page.keyboard.type('1+1=?', { delay: 50 });
      await page.waitForTimeout(500);
      
      console.log('已输入消息，准备发送...');
      
      // 记录发送前的请求数
      const reqCountBefore = allRequests.length;
      const respCountBefore = allResponses.length;
      
      // 按 Enter 发送
      await page.keyboard.press('Enter');
      
      // 等待响应
      await page.waitForTimeout(10000);
      
      // 打印新增的请求
      const newRequests = allRequests.slice(reqCountBefore);
      const newResponses = allResponses.slice(respCountBefore);
      
      console.log(`\n=== 发送后新增 ${newRequests.length} 个请求 ===`);
      for (const req of newRequests) {
        console.log(`\n  [REQ] ${req.method} ${req.url}`);
        if (req.postData) console.log(`  Body: ${req.postData.slice(0, 500)}`);
        console.log(`  Headers:`, JSON.stringify(req.headers, null, 4));
      }
      
      console.log(`\n=== 发送后新增 ${newResponses.length} 个响应 ===`);
      for (const resp of newResponses) {
        console.log(`\n  [RESP] ${resp.status} ${resp.url}`);
        console.log(`  Content-Type: ${resp.contentType}`);
        if (resp.body) console.log(`  Body: ${resp.body.slice(0, 1000)}`);
      }
    } catch (e) {
      console.log('输入框操作失败:', e.message);
    }
  } else {
    console.log('未找到可见的输入框');
  }

  // 保存所有请求到文件
  await writeFile('debug/spark-requests.json', JSON.stringify(allRequests, null, 2), 'utf-8');
  await writeFile('debug/spark-responses.json', JSON.stringify(allResponses, null, 2), 'utf-8');
  console.log('\n请求日志已保存到 debug/spark-*.json');

  await page.close();
  browser.close();
}

main().catch(e => console.error(e.message));
