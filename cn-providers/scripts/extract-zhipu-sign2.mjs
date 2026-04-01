#!/usr/bin/env node
/**
 * 深入分析 Zhipu X-Sign 生成算法
 * 通过 webpack 模块搜索签名相关代码
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

  // 第1步：搜索 webpack 模块中的签名代码
  console.log('\n=== 搜索 webpack 模块中的签名代码 ===');
  const signModules = await page.evaluate(() => {
    const results = [];
    const chunks = window.webpackChunkzp_chat_glm;
    if (!Array.isArray(chunks)) return ['webpackChunkzp_chat_glm not found'];
    
    for (let ci = 0; ci < chunks.length; ci++) {
      const mods = chunks[ci][1];
      if (!mods) continue;
      
      for (const [id, fn] of Object.entries(mods)) {
        const src = fn.toString();
        
        // 搜索 X-Sign 相关
        if (src.includes('X-Sign') || src.includes('x-sign') || src.includes('X-Nonce') || src.includes('x-nonce')) {
          results.push({
            type: 'sign-header',
            moduleId: id,
            chunkIdx: ci,
            snippet: src.slice(0, 2000),
            length: src.length,
          });
        }
        
        // 搜索 MD5 相关但排除太长的模块（可能是 MD5 实现本身）
        if (src.length < 5000 && (src.includes('MD5') || src.includes('md5'))) {
          const hasSign = src.includes('sign') || src.includes('Sign');
          if (hasSign) {
            results.push({
              type: 'md5-sign',
              moduleId: id,
              chunkIdx: ci,
              snippet: src.slice(0, 2000),
              length: src.length,
            });
          }
        }

        // 搜索签名函数特征：timestamp + nonce + sign 组合
        if (src.includes('timestamp') && src.includes('nonce') && src.includes('sign') && src.length < 5000) {
          results.push({
            type: 'timestamp-nonce-sign',
            moduleId: id,
            chunkIdx: ci,
            snippet: src.slice(0, 3000),
            length: src.length,
          });
        }
      }
    }
    
    return results;
  });

  if (signModules.length === 0) {
    console.log('在 webpack 模块中未直接找到签名代码');
    console.log('尝试从下载的 JS 文件中搜索...');
    
    // 获取页面上所有 script 标签的 src
    const scripts = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
    });
    console.log('页面脚本:', scripts);

    // 也搜索 performance entries 获取动态加载的脚本
    const perfScripts = await page.evaluate(() => {
      return performance.getEntriesByType('resource')
        .filter(r => r.initiatorType === 'script' || r.name.endsWith('.js'))
        .map(r => ({ name: r.name, size: r.transferSize }))
        .sort((a, b) => b.size - a.size)
        .slice(0, 20);
    });
    console.log('\n动态加载的 JS 文件（按大小排序）:');
    for (const s of perfScripts) {
      console.log(`  ${s.size} bytes - ${s.name}`);
    }

  } else {
    console.log(`找到 ${signModules.length} 个相关模块\n`);
    for (const mod of signModules) {
      console.log(`--- [${mod.type}] module ${mod.moduleId} (chunk ${mod.chunkIdx}, ${mod.length} chars) ---`);
      console.log(mod.snippet);
      console.log('---\n');
    }
  }

  // 第2步：尝试直接在页面中执行签名并观察
  console.log('\n=== 尝试 hook 并生成签名 ===');
  const hookResult = await page.evaluate(() => {
    const results = [];
    const chunks = window.webpackChunkzp_chat_glm;
    if (!Array.isArray(chunks)) return results;
    
    // 遍历模块寻找导出 sign/getSign/createSign 的模块
    const moduleCache = {};
    for (let ci = 0; ci < chunks.length; ci++) {
      const mods = chunks[ci][1];
      if (!mods) continue;
      
      for (const [id, fn] of Object.entries(mods)) {
        // 创建模块执行环境
        const mod = { exports: {} };
        try {
          // 检查函数参数数量来判断是否是 webpack 模块
          if (fn.length <= 3) {
            const requireFn = (depId) => {
              if (moduleCache[depId]) return moduleCache[depId];
              return {};
            };
            requireFn.n = (m) => () => m;
            requireFn.d = (exports, definitions) => {
              for (const key in definitions) {
                Object.defineProperty(exports, key, { get: definitions[key], enumerable: true });
              }
            };
            requireFn.r = () => {};
            
            fn(mod, mod.exports, requireFn);
            moduleCache[id] = mod.exports;
            
            // 检查导出中是否有签名相关函数
            for (const [key, val] of Object.entries(mod.exports)) {
              if (typeof val === 'function') {
                const fnStr = val.toString();
                if (fnStr.includes('sign') || fnStr.includes('Sign') || fnStr.includes('nonce') || fnStr.includes('timestamp')) {
                  results.push({
                    moduleId: id,
                    exportKey: key,
                    fnStr: fnStr.slice(0, 1000),
                  });
                }
              }
            }
          }
        } catch (e) {
          // 忽略模块加载错误
        }
      }
    }
    
    return results;
  });

  if (hookResult.length > 0) {
    console.log(`找到 ${hookResult.length} 个签名相关导出函数:`);
    for (const h of hookResult) {
      console.log(`\n  Module ${h.moduleId}, export: ${h.exportKey}`);
      console.log(`  ${h.fnStr}`);
    }
  }

  await page.close();
  browser.close();
}

main().catch(e => console.error(e.message));
