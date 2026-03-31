/**
 * 模型路由：model 名称 → { providerName, Provider 实例 }。
 * 支持运行时注册 token（多账号轮询），以及列出可用模型。
 */

import { QwenProvider } from './providers/qwen.mjs';
import { KimiProvider } from './providers/kimi.mjs';
import { ZhipuProvider } from './providers/zhipu.mjs';
import { DoubaoProvider } from './providers/doubao.mjs';
import { DeepSeekProvider } from './providers/deepseek.mjs';
import { HailuoProvider } from './providers/hailuo.mjs';
import { StepProvider } from './providers/step.mjs';
import { SparkProvider } from './providers/spark.mjs';
import { MetasoProvider } from './providers/metaso.mjs';
import { YuanbaoProvider } from './providers/yuanbao.mjs';
import {
  BaichuanProvider,
  YiProvider,
  SenseNovaProvider,
  TiangongProvider,
} from './providers/openai-compatible.mjs';

/**
 * model → provider 映射表
 * key: 用户请求的 model 名
 * value: 对应的 provider 名
 */
const MODEL_PROVIDER_MAP = {
  // Qwen (通义千问)
  'qwen-max': 'qwen',
  'qwen-plus': 'qwen',
  'qwen-turbo': 'qwen',
  'qwen-long': 'qwen',
  qwen: 'qwen',
  // Kimi (月之暗面)
  kimi: 'kimi',
  moonshot: 'kimi',
  'kimi-k1': 'kimi',
  k1: 'kimi',
  // 智谱清言
  'glm-4': 'zhipu',
  chatglm: 'zhipu',
  'glm-4-zero': 'zhipu',
  'glm-zero': 'zhipu',
  zhipu: 'zhipu',
  // 豆包
  doubao: 'doubao',
  'doubao-pro': 'doubao',
  // DeepSeek
  deepseek: 'deepseek',
  'deepseek-chat': 'deepseek',
  'deepseek-v3': 'deepseek',
  'deepseek-r1': 'deepseek',
  'deepseek-reasoner': 'deepseek',
  'deepseek-code': 'deepseek',
  'deepseek-coder': 'deepseek',
  // 海螺AI (MiniMax)
  hailuo: 'hailuo',
  minimax: 'hailuo',
  'minimax-text': 'hailuo',
  // 阶跃星辰 StepChat
  step: 'step',
  stepchat: 'step',
  'step-2': 'step',
  'step-flash': 'step',
  // 讯飞星火
  spark: 'spark',
  'spark-ultra': 'spark',
  'spark-max': 'spark',
  'spark-pro': 'spark',
  'spark-lite': 'spark',
  // 秘塔AI
  metaso: 'metaso',
  'metaso-concise': 'metaso',
  'metaso-detail': 'metaso',
  'metaso-research': 'metaso',
  // 腾讯元宝
  yuanbao: 'yuanbao',
  'yuanbao-deepseek': 'yuanbao',
  'yuanbao-hunyuan': 'yuanbao',
  // 百川智能 (API Key)
  baichuan: 'baichuan',
  'baichuan-4': 'baichuan',
  'baichuan-3': 'baichuan',
  'baichuan-turbo': 'baichuan',
  // 零一万物 Yi (API Key)
  yi: 'yi',
  'yi-lightning': 'yi',
  'yi-large': 'yi',
  'yi-medium': 'yi',
  wanzhi: 'yi',
  // 商汤 SenseNova (API Key)
  sensenova: 'sensenova',
  sensechat: 'sensenova',
  'sensechat-5': 'sensenova',
  shangtan: 'sensenova',
  // 天工 Tiangong (API Key)
  tiangong: 'tiangong',
  skychat: 'tiangong',
  'sky-chat': 'tiangong',
};

/** Provider 构造函数映射 */
const PROVIDER_CONSTRUCTORS = {
  // Web 模式 (Cookie/token)
  qwen: QwenProvider,
  kimi: KimiProvider,
  zhipu: ZhipuProvider,
  doubao: DoubaoProvider,
  deepseek: DeepSeekProvider,
  hailuo: HailuoProvider,
  step: StepProvider,
  spark: SparkProvider,
  metaso: MetasoProvider,
  yuanbao: YuanbaoProvider,
  // 官方 API 模式 (API Key)
  baichuan: BaichuanProvider,
  yi: YiProvider,
  sensenova: SenseNovaProvider,
  tiangong: TiangongProvider,
};

/**
 * 管理 token 池和 provider 实例的路由器。
 * 每个 provider 可以注册多个 token，请求时轮询选取。
 */
export class ProviderRouter {
  constructor() {
    /**
     * providerName → { tokens: string[], index: number }
     * @type {Map<string, { tokens: string[]; index: number }>}
     */
    this.tokenPools = new Map();
  }

  /**
   * 注册一个 token 到指定 provider
   * @param {string} providerName  qwen | kimi | zhipu | doubao
   * @param {string} token
   */
  addToken(providerName, token) {
    const name = providerName.toLowerCase();
    if (!PROVIDER_CONSTRUCTORS[name]) {
      throw new Error(`未知 provider: ${name}`);
    }
    let pool = this.tokenPools.get(name);
    if (!pool) {
      pool = { tokens: [], index: 0 };
      this.tokenPools.set(name, pool);
    }
    if (!pool.tokens.includes(token)) {
      pool.tokens.push(token);
    }
  }

  /**
   * 移除指定 provider 的某个 token
   * @param {string} providerName
   * @param {string} token
   */
  removeToken(providerName, token) {
    const pool = this.tokenPools.get(providerName.toLowerCase());
    if (!pool) return;
    pool.tokens = pool.tokens.filter((t) => t !== token);
  }

  /**
   * 根据 model 名解析出 provider 信息并创建实例（轮询选 token）
   * @param {string} model
   * @returns {{ provider: InstanceType<typeof QwenProvider | typeof KimiProvider | typeof ZhipuProvider | typeof DoubaoProvider>; providerName: string; token: string } | null}
   */
  resolve(model) {
    const m = (model ?? '').trim().toLowerCase();
    const providerName = MODEL_PROVIDER_MAP[m];
    if (!providerName) return null;

    const pool = this.tokenPools.get(providerName);
    if (!pool || pool.tokens.length === 0) return null;

    // round-robin 选取 token
    const token = pool.tokens[pool.index % pool.tokens.length];
    pool.index = (pool.index + 1) % pool.tokens.length;

    const Ctor = PROVIDER_CONSTRUCTORS[providerName];
    const provider = new Ctor(token);
    return { provider, providerName, token };
  }

  /** 列出所有已注册 token 的可用模型 */
  listModels() {
    const models = [];
    for (const [model, providerName] of Object.entries(MODEL_PROVIDER_MAP)) {
      const pool = this.tokenPools.get(providerName);
      if (pool && pool.tokens.length > 0) {
        models.push({
          id: model,
          object: 'model',
          created: 0,
          owned_by: `cn-providers/${providerName}`,
        });
      }
    }
    return models;
  }

  /** 列出所有 provider 的 token 数量统计 */
  status() {
    const result = {};
    for (const [name, pool] of this.tokenPools) {
      result[name] = pool.tokens.length;
    }
    return result;
  }
}
