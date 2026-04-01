#!/usr/bin/env node
/**
 * Chat2API 配置同步工具
 *
 * 读取 refs/chat2api/ 中的 builtin provider 配置（TypeScript），
 * 提取模型列表、端点、请求头等关键协议信息，
 * 生成 JSON 参考文件供 cn-providers 对照更新。
 *
 * 用法:
 *   node cn-providers/scripts/sync-chat2api.mjs
 *
 * 输出:
 *   cn-providers/chat2api-reference.json   — 上游协议参考快照
 *   控制台对比当前 cn-providers 与 Chat2API 的差异
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CHAT2API_BUILTIN = path.join(PROJECT_ROOT, 'refs/chat2api/src/main/providers/builtin');
const OUTPUT_FILE = path.join(PROJECT_ROOT, 'cn-providers/chat2api-reference.json');

// 我们已有的 provider 与 Chat2API 的 ID 对应关系
const OUR_TO_CHAT2API = {
  qwen: 'qwen',
  kimi: 'kimi',
  zhipu: 'glm',
  deepseek: 'deepseek',
  hailuo: 'minimax',
  // 以下是 Chat2API 有但我们未单独实现的
  // 'qwen-ai': (国际站), 'zai': (Z.ai), 'perplexity': (海外)
};

/**
 * 从 TypeScript 配置文件中提取 BuiltinProviderConfig 的关键字段。
 * 用正则简单解析，避免引入 TS 编译器。
 */
function parseBuiltinConfig(filePath) {
  const src = fs.readFileSync(filePath, 'utf-8');

  const extract = (key) => {
    // 匹配 key: 'value' 或 key: "value"
    const m = src.match(new RegExp(`${key}:\\s*['"]([^'"]+)['"]`));
    return m ? m[1] : null;
  };

  // 提取数组字段（如 supportedModels）
  const extractArray = (key) => {
    const m = src.match(new RegExp(`${key}:\\s*\\[([^\\]]+)\\]`, 's'));
    if (!m) return [];
    return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
  };

  // 提取对象字段（如 modelMappings, headers）
  const extractObject = (key) => {
    const startMatch = src.match(new RegExp(`${key}:\\s*\\{`));
    if (!startMatch) return {};
    let depth = 0;
    let startIdx = startMatch.index + startMatch[0].length - 1;
    let endIdx = startIdx;
    for (let i = startIdx; i < src.length; i++) {
      if (src[i] === '{') depth++;
      if (src[i] === '}') depth--;
      if (depth === 0) { endIdx = i + 1; break; }
    }
    const block = src.slice(startIdx, endIdx);
    const obj = {};
    for (const match of block.matchAll(/['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g)) {
      obj[match[1]] = match[2];
    }
    return obj;
  };

  // 提取 credentialFields
  const extractCredFields = () => {
    const fields = [];
    const re = /\{\s*name:\s*['"]([^'"]+)['"],\s*label:\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const reqMatch = src.slice(m.index, m.index + 300).match(/required:\s*(true|false)/);
      fields.push({ name: m[1], label: m[2], required: reqMatch ? reqMatch[1] === 'true' : false });
    }
    return fields;
  };

  return {
    id: extract('id'),
    name: extract('name'),
    authType: extract('authType'),
    apiEndpoint: extract('apiEndpoint'),
    chatPath: extract('chatPath'),
    headers: extractObject('headers'),
    supportedModels: extractArray('supportedModels'),
    modelMappings: extractObject('modelMappings'),
    credentialFields: extractCredFields(),
    tokenCheckEndpoint: extract('tokenCheckEndpoint'),
    tokenCheckMethod: extract('tokenCheckMethod'),
  };
}

function main() {
  if (!fs.existsSync(CHAT2API_BUILTIN)) {
    console.error(`❌ Chat2API 参考代码未找到: ${CHAT2API_BUILTIN}`);
    console.error('   请先运行: cd refs/chat2api && git pull');
    process.exit(1);
  }

  const files = fs.readdirSync(CHAT2API_BUILTIN)
    .filter((f) => f.endsWith('.ts') && f !== 'index.ts');

  const providers = {};
  for (const file of files) {
    const config = parseBuiltinConfig(path.join(CHAT2API_BUILTIN, file));
    if (config.id) {
      providers[config.id] = config;
    }
  }

  // 写入参考文件
  const output = {
    _generated: new Date().toISOString(),
    _source: 'refs/chat2api/src/main/providers/builtin/',
    _usage: '此文件由 sync-chat2api.mjs 自动生成，供 cn-providers 对照更新协议逻辑',
    providers,
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`✅ 已生成参考文件: ${OUTPUT_FILE}`);
  console.log(`   共提取 ${Object.keys(providers).length} 个 provider 配置\n`);

  // 对比差异
  console.log('─── 协议对照报告 ───\n');

  for (const [ourName, c2aId] of Object.entries(OUR_TO_CHAT2API)) {
    const ref = providers[c2aId];
    if (!ref) {
      console.log(`⚠️  ${ourName} → Chat2API:${c2aId} 未找到配置`);
      continue;
    }
    console.log(`📦 ${ourName} ↔ Chat2API:${c2aId}`);
    console.log(`   端点: ${ref.apiEndpoint}${ref.chatPath}`);
    console.log(`   认证: ${ref.authType} (${ref.credentialFields.map((f) => f.name).join(', ')})`);
    console.log(`   模型: ${ref.supportedModels.join(', ')}`);
    if (Object.keys(ref.modelMappings).length > 0) {
      console.log(`   映射: ${JSON.stringify(ref.modelMappings)}`);
    }
    console.log();
  }

  // Chat2API 中有但我们未覆盖的 provider
  const coveredIds = new Set(Object.values(OUR_TO_CHAT2API));
  const uncovered = Object.keys(providers).filter((id) => !coveredIds.has(id));
  if (uncovered.length > 0) {
    console.log('─── 我们未覆盖的 Chat2API Provider ───\n');
    for (const id of uncovered) {
      const ref = providers[id];
      console.log(`📦 ${ref.name} (${id})`);
      console.log(`   端点: ${ref.apiEndpoint}`);
      console.log(`   认证: ${ref.authType}`);
      console.log(`   模型: ${ref.supportedModels.join(', ')}`);
      console.log();
    }
  }

  console.log('─── 使用方式 ───');
  console.log('1. 更新 Chat2API:  cd refs/chat2api && git pull');
  console.log('2. 重新同步:       node cn-providers/scripts/sync-chat2api.mjs');
  console.log('3. 对照更新:       比较 chat2api-reference.json 中的端点、模型、请求头');
  console.log('                   然后手动更新对应的 cn-providers/src/providers/*.mjs');
}

main();
