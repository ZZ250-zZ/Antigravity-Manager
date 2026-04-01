#!/usr/bin/env node
/**
 * 提取 Zhipu 签名模块 93990 的完整代码
 */
import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const page = await context.newPage();

  console.log('导航到 chatglm...');
  await page.goto('https://chatglm.cn/main/chatfree', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // 提取模块 93990 的完整代码
  console.log('\n=== 提取模块 93990 (签名模块) ===');
  const signModule = await page.evaluate(() => {
    const chunks = window.webpackChunkzp_chat_glm;
    if (!Array.isArray(chunks)) return { error: 'webpackChunkzp_chat_glm not found' };

    const results = {};

    for (let ci = 0; ci < chunks.length; ci++) {
      const mods = chunks[ci][1];
      if (!mods) continue;

      // 查找模块 93990
      if (mods['93990']) {
        results.module93990 = {
          chunkIdx: ci,
          code: mods['93990'].toString(),
        };
      }

      // 同时查找依赖模块 26405 (l.yk - 生成 requestId)
      if (mods['26405']) {
        results.module26405 = {
          chunkIdx: ci,
          code: mods['26405'].toString(),
        };
      }

      // 查找 63484 (r - 常量模块)
      if (mods['63484']) {
        results.module63484 = {
          chunkIdx: ci,
          code: mods['63484'].toString().slice(0, 2000),
        };
      }
      
      // 查找 20423 (CryptoJS)
      if (mods['20423']) {
        results.module20423 = {
          chunkIdx: ci,
          codeLength: mods['20423'].toString().length,
          snippet: mods['20423'].toString().slice(0, 500),
        };
      }
      
      // 查找 47997 (a - IP/device 相关)
      if (mods['47997']) {
        const src = mods['47997'].toString();
        results.module47997 = {
          chunkIdx: ci,
          codeLength: src.length,
          snippet: src.slice(0, 2000),
        };
      }
    }

    return results;
  });

  if (signModule.error) {
    console.log('错误:', signModule.error);
  } else {
    // 输出模块 93990 的完整代码
    if (signModule.module93990) {
      console.log(`\n--- 模块 93990 (chunk ${signModule.module93990.chunkIdx}) ---`);
      console.log(signModule.module93990.code);
      console.log('--- END ---');
    } else {
      console.log('未找到模块 93990');
      
      // 搜索包含 o0 导出的模块
      const o0Module = await page.evaluate(() => {
        const chunks = window.webpackChunkzp_chat_glm;
        const results = [];
        
        for (let ci = 0; ci < chunks.length; ci++) {
          const mods = chunks[ci][1];
          if (!mods) continue;
          
          for (const [id, fn] of Object.entries(mods)) {
            const src = fn.toString();
            if (src.includes('o0') && src.includes('timestamp') && src.includes('xNonce') && src.includes('sign')) {
              results.push({ moduleId: id, chunkIdx: ci, code: src });
            }
            // 也搜索导出 o0 的定义
            if (src.includes('"o0"') || src.includes("'o0'") || src.includes('o0:')) {
              const hasSig = src.includes('sign') || src.includes('Sign');
              if (hasSig) {
                results.push({ moduleId: id, chunkIdx: ci, code: src.slice(0, 3000), type: 'export-o0' });
              }
            }
          }
        }
        
        return results;
      });
      
      console.log(`\n找到 ${o0Module.length} 个包含 o0+sign 的模块:`);
      for (const m of o0Module) {
        console.log(`\n--- Module ${m.moduleId} (chunk ${m.chunkIdx}) ${m.type || ''} ---`);
        console.log(m.code);
        console.log('---');
      }
    }

    // 输出模块 26405
    if (signModule.module26405) {
      console.log(`\n--- 模块 26405 (chunk ${signModule.module26405.chunkIdx}) ---`);
      console.log(signModule.module26405.code);
      console.log('--- END ---');
    }
  }

  // 第3步：直接在页面中调用签名函数
  console.log('\n=== 直接在页面中调用签名函数 ===');
  const signResult = await page.evaluate(() => {
    const chunks = window.webpackChunkzp_chat_glm;
    if (!Array.isArray(chunks)) return { error: 'no chunks' };
    
    // 尝试通过 webpack require 调用模块
    // webpack 的 __webpack_require__ 通常挂载在 chunk 的第三个元素上
    // 但更好的方式是通过 hook 来获取

    // 搜索所有模块，找到包含 o0 函数的模块并直接在浏览器中调用
    for (let ci = 0; ci < chunks.length; ci++) {
      const mods = chunks[ci][1];
      if (!mods) continue;
      
      for (const [id, fn] of Object.entries(mods)) {
        const src = fn.toString();
        // 搜索 ve (token getter) 和 o0 (sign generator) 的导出定义
        if (src.includes('ve:') && src.includes('o0:') && src.includes('gf:')) {
          return { found: true, moduleId: id, chunkIdx: ci, snippet: src.slice(0, 3000) };
        }
      }
    }
    
    return { found: false };
  });
  
  console.log('签名函数搜索结果:', JSON.stringify(signResult, null, 2));

  await page.close();
  browser.close();
}

main().catch(e => console.error(e.message));
