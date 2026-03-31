/**
 * 网络请求捕获脚本
 * 
 * 在浏览器中使用各 AI 服务时，捕获并记录实际的 API 请求。
 * 用于逆向分析 API 协议。
 * 
 * 用法:
 *   1. 启动 Edge: & "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222
 *   2. 在 Edge 中打开目标 AI 服务
 *   3. 运行: node scripts/capture-api.mjs --cdp --target=zhipu
 *   4. 在 Edge 中发送一条消息
 *   5. 脚本会自动捕获 API 请求并输出
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const target = args.find(a => a.startsWith('--target='))?.split('=')[1] || 'all';

const TARGETS = {
  zhipu: {
    name: '智谱清言',
    url: 'https://chatglm.cn',
    urlPatterns: ['chatglm.cn/chatglm', 'chatglm.cn/trpc'],
  },
  doubao: {
    name: '豆包',
    url: 'https://www.doubao.com',
    urlPatterns: ['doubao.com/samantha', 'doubao.com/alice', 'doubao.com/api'],
  },
  kimi: {
    name: 'Kimi',
    url: 'https://kimi.moonshot.cn',
    urlPatterns: ['kimi.moonshot.cn/api'],
  },
  qwen: {
    name: '通义千问',
    url: 'https://tongyi.aliyun.com',
    urlPatterns: ['qianwen', 'tongyi'],
  },
};

async function main() {
  console.log('=== API 请求捕获工具 ===\n');

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  
  if (!context) {
    console.log('❌ 未找到浏览器上下文');
    return;
  }

  const targets = target === 'all' ? Object.keys(TARGETS) : [target];
  
  for (const t of targets) {
    const config = TARGETS[t];
    if (!config) {
      console.log(`❌ 未知目标: ${t}`);
      continue;
    }

    console.log(`\n========== 捕获 ${config.name} 的 API 请求 ==========\n`);
    console.log(`请在 Edge 中打开 ${config.url} 并发送一条消息。`);
    console.log(`捕获中... (按 Ctrl+C 停止)\n`);

    // 监听所有页面的网络请求
    const pages = context.pages();
    let captured = 0;
    
    const handleRequest = async (request) => {
      const url = request.url();
      const isRelevant = config.urlPatterns.some(p => url.includes(p));
      if (!isRelevant) return;
      
      const method = request.method();
      // 只关注 POST 和 GET 请求
      if (!['POST', 'GET'].includes(method)) return;
      
      captured++;
      console.log(`\n--- 请求 #${captured} ---`);
      console.log(`  ${method} ${url}`);
      
      // 打印关键请求头
      const headers = request.headers();
      const importantHeaders = ['authorization', 'cookie', 'content-type', 'x-sign', 'x-nonce', 
        'x-timestamp', 'x-device-id', 'x-request-id', 'app-name', 'platform', 'x-xsrf-token',
        'x-platform', 'x-msh-platform', 'x-traffic-id', 'agw-js-conv', 'x-flow-trace',
        'referer', 'origin'];
      
      console.log('  Headers:');
      for (const h of importantHeaders) {
        if (headers[h]) {
          let val = headers[h];
          // Cookie 只显示名称
          if (h === 'cookie') {
            val = val.split(';').map(c => c.trim().split('=')[0]).join(', ');
          }
          // 超长值截断
          if (val.length > 100) val = val.slice(0, 100) + '...';
          console.log(`    ${h}: ${val}`);
        }
      }

      // 打印请求体
      const postData = request.postData();
      if (postData) {
        console.log(`  Body (${postData.length} chars):`);
        try {
          const json = JSON.parse(postData);
          console.log(`    ${JSON.stringify(json, null, 2).slice(0, 500)}`);
        } catch(e) {
          console.log(`    ${postData.slice(0, 300)}`);
        }
      }
    };

    const handleResponse = async (response) => {
      const url = response.url();
      const isRelevant = config.urlPatterns.some(p => url.includes(p));
      if (!isRelevant) return;
      
      const status = response.status();
      const contentType = response.headers()['content-type'] || '';
      
      console.log(`  Response: ${status} (${contentType})`);
      
      // 尝试获取响应体（非 SSE）
      if (!contentType.includes('event-stream') && status !== 200) {
        try {
          const body = await response.text();
          console.log(`  Response Body: ${body.slice(0, 300)}`);
        } catch(e) {}
      }
      
      if (contentType.includes('event-stream')) {
        console.log(`  [SSE Stream - 内容在浏览器中查看]`);
      }
    };

    for (const page of pages) {
      page.on('request', handleRequest);
      page.on('response', handleResponse);
    }

    // 也监听新打开的页面
    context.on('page', (page) => {
      page.on('request', handleRequest);
      page.on('response', handleResponse);
    });

    // 等待用户操作
    await new Promise(resolve => {
      console.log('等待 60 秒或按 Ctrl+C 停止...');
      setTimeout(resolve, 60000);
    });

    console.log(`\n共捕获 ${captured} 个相关请求`);
  }

  await browser.close().catch(() => {});
}

main().catch(console.error);
