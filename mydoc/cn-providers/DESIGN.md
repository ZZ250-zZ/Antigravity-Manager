# CN Providers Sidecar 设计文档

## 1. 需求概述

为 Antigravity Manager 添加中国大模型的 Web 端协议支持。通过 Node.js Sidecar 服务接收 OpenAI 格式请求，转换为各 Provider 的 Web API 协议，实现免费的 AI 代理服务。

**共支持 14 家 AI 厂商**：10 家 Web 模式（Cookie/Token 免费访问）+ 4 家官方 API 代理模式（API Key）。

### 设计原则
- **最小侵入**：独立 Node.js 项目（`cn-providers/`），不修改 Rust 核心代码
- **统一架构**：所有 Provider 使用相同的 HTTP 客户端（wreq-js，TLS 指纹伪装）
- **便于更新**：fork 仓库可轻松合并上游改动
- **仅 Web 模式**：只接入 Cookie/Token 免费访问的 Web 端 AI，不接入需要 API Key 付费的官方 API 渠道

## 2. 协议分析结论

### 2.1 Provider API 概要

#### Web 模式 Provider（Cookie/Token 免费访问）

| Provider | API 端点 | 协议 | 认证方式 | 签名/特殊机制 |
|----------|---------|------|---------|------|
| 通义千问 Qwen | `qianwen.biz.aliyun.com/dialog/conversation` | HTTP/2 SSE | `tongyi_sso_ticket` Cookie | 无 |
| Kimi 月之暗面 | `kimi.moonshot.cn/api/chat/...` | HTTP SSE | Bearer Token (refresh→access) | 无 |
| 智谱清言 | `chatglm.cn/chatglm/backend-api/assistant/stream` | HTTP SSE | Bearer Token (refresh→access) | **x-sign: MD5(ts-nonce-secret)** |
| 豆包 | `www.doubao.com/samantha/chat/completion` | HTTP SSE | `sessionid` Cookie | fake a_bogus + msToken |
| DeepSeek | `chat.deepseek.com/api/v0/chat/completion` | HTTP SSE | Bearer Token (userToken) | **PoW 挑战 (SHA3-256)** |
| 海螺AI (MiniMax) | `hailuoai.com/api/chat/completion` | HTTP SSE | Bearer Token (_token) | 无 |
| 阶跃星辰 StepChat | `stepchat.cn/api/chat/completion` | HTTP SSE | Oasis-Token | 可选 deviceId |
| 讯飞星火 | `xinghuo.xfyun.cn/iflygpt-chat/u/chat/send_text` | HTTP SSE | `ssoSessionId` Cookie | 无 |
| 秘塔AI | `metaso.cn/api/search` | HTTP SSE | `uid`+`sid` Cookie | 搜索增强式 |
| 腾讯元宝 | `yuanbao.tencent.com/api/chat/{uuid}` | HTTP SSE | 完整 Cookie 字符串 | 无 |

> **注意**：不接入官方 API Key 付费渠道（百川/零一/商汤/天工等），仅保留 Web 免费模式。

### 2.2 验证结果

所有 Provider 均已通过 Playwright + 实际 API 调用验证：

- **Qwen**：✅ 完全验证，HTTP/2 SSE 流式返回正常
- **Kimi**：✅ 完全验证，refresh_token→access_token 流程正常
- **智谱**：✅ 完全验证，需要 x-sign MD5 签名（`MD5(timestamp-nonce-8a1317a7468aa3ad86e997d08f3f31cb)`）
- **豆包**：✅ API 连通验证，a_bogus/msToken 可随机生成（服务端不验证）

### 2.3 关键发现

1. **TLS 指纹**：当前所有 Provider 不严格验证 TLS 指纹，但使用 wreq-js 作为保险
2. **智谱 x-sign**：必需，缺少时返回 40011；签名 secret 为固定值 `8a1317a7468aa3ad86e997d08f3f31cb`
3. **豆包 a_bogus**：服务端不验证，可用 `mf-{random34}-{random6}` 格式的随机值
4. **豆包 msToken**：服务端不验证，可用 96 字节 base64 随机值

## 3. 技术架构

```
┌──────────────────────────────────────────────────────────────┐
│                     Antigravity Manager                      │
│                                                              │
│  ┌─────────────┐    ┌────────────────────────────────────┐  │
│  │  Rust Core   │    │       CN Providers Sidecar          │  │
│  │  (Axum)      │    │       (Node.js / Express)           │  │
│  │              │    │                                      │  │
│  │ /v1/chat/    │───▶│  /v1/chat/completions               │  │
│  │ completions  │    │         │                            │  │
│  │              │    │   ┌─────▼──────┐                     │  │
│  │ Google/      │    │   │  Router    │                     │  │
│  │ Anthropic/   │    │   │  (model→   │                     │  │
│  │ Gemini       │    │   │  provider) │                     │  │
│  │              │    │   └─────┬──────┘                     │  │
│  └──────────────┘    │   ┌─────▼──────┐                     │  │
│                      │   │  Provider   │                     │  │
│                      │   │  Handlers   │                     │  │
│                      │   │             │                     │  │
│                      │   │ ┌─────────┐ │   ┌──────────┐     │  │
│                      │   │ │  Qwen   │─┼──▶│ wreq-js  │     │  │
│                      │   │ ├─────────┤ │   │ (Rust    │     │  │
│                      │   │ │  Kimi   │─┼──▶│  TLS     │     │  │
│                      │   │ ├─────────┤ │   │  指纹)   │     │  │
│                      │   │ │  智谱   │─┼──▶│          │     │  │
│                      │   │ ├─────────┤ │   │ Chrome/  │     │  │
│                      │   │ │  豆包   │─┼──▶│ Edge     │     │  │
│                      │   │ └─────────┘ │   │ Profile  │     │  │
│                      │   └─────┬──────┘   └──────────┘     │  │
│                      │   ┌─────▼──────┐                     │  │
│                      │   │  Token     │                     │  │
│                      │   │  Manager   │                     │  │
│                      │   │ (刷新/轮换) │                     │  │
│                      │   └────────────┘                     │  │
│                      └────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 3.1 目录结构

```
cn-providers/
├── package.json
├── src/
│   ├── index.mjs              # 入口，Express 服务器 + OpenAI API 路由
│   ├── config.mjs             # 配置管理（端口、日志级别）
│   ├── router.mjs             # 模型名→Provider 路由 + Token 池轮询
│   ├── http-client.mjs        # wreq-js 封装（TLS 指纹伪装，edge_145）
│   ├── providers/
│   │   ├── qwen.mjs           # 通义千问（tongyi_sso_ticket Cookie）
│   │   ├── kimi.mjs           # Kimi / 月之暗面（refresh→access Bearer）
│   │   ├── zhipu.mjs          # 智谱清言 / ChatGLM（refresh + X-Sign MD5）
│   │   ├── doubao.mjs         # 豆包（sessionid Cookie + fake a_bogus）
│   │   ├── deepseek.mjs       # DeepSeek（PoW 挑战 + SSE）
│   │   ├── hailuo.mjs         # 海螺AI / MiniMax（_token Bearer）
│   │   ├── step.mjs           # 阶跃星辰 StepChat（Oasis-Token）
│   │   ├── spark.mjs          # 讯飞星火（ssoSessionId Cookie）
│   │   ├── metaso.mjs         # 秘塔AI（uid+sid Cookie，搜索模式）
│   │   └── yuanbao.mjs        # 腾讯元宝（完整 Cookie 字符串）
│   ├── converters/
│   │   ├── native-to-openai.mjs   # 纯胶水层：通过 sse-registry 分发到各 provider
│   │   └── sse-registry.mjs       # SSE 处理函数注册表（各 provider 自注册）
│   └── utils/
│       ├── deepseek-pow.mjs       # DeepSeek SHA3-256 PoW 挑战求解器
│       ├── token-manager.mjs      # access_token 缓存 + 自动刷新
│       ├── conversation-tracker.mjs # 仅跟踪自建会话，安全清理
│       ├── sse-parser.mjs         # 通用 SSE 流解析（回调模式）
│       └── sign.mjs               # 智谱 MD5 签名 + 无横线 UUID
├── scripts/
│   ├── test-all.mjs           # 端到端集成测试（基础设施 + 流式/非流式）
│   ├── verify-qwen.mjs        # Qwen 协议验证（Playwright）
│   └── ...                    # 其他验证脚本
└── mydoc/
    └── cn-providers/DESIGN.md # 本设计文档
```

### 3.2 HTTP 客户端

使用 `wreq-js` 作为统一 HTTP 客户端，所有出站请求均经 TLS 指纹伪装：

```javascript
// http-client.mjs — 惰性单例 Session
import { createSession } from 'wreq-js';

let sessionPromise = null;
function getSession() {
  if (!sessionPromise) {
    sessionPromise = createSession({ browser: 'edge_145', os: 'windows' });
  }
  return sessionPromise;
}

export async function httpRequest(url, options = {}) {
  const session = await getSession();
  return session.fetch(url, {
    ...options,
    headers: { ...defaultHeaders, ...options.headers },
  });
}
```

### 3.3 Rust 核心集成方式

在 Rust 代理服务器中添加一个通用的 CN Provider 转发路由：

```rust
// proxy/server.rs 中添加
.route("/v1/cn/:provider/*path", post(cn_provider_proxy))

// cn_provider_proxy handler 简单地将请求转发到 Node.js sidecar
async fn cn_provider_proxy(
    Path((provider, path)): Path<(String, String)>,
    body: Body,
) -> impl IntoResponse {
    // 转发到 http://127.0.0.1:{SIDECAR_PORT}/{path}
}
```

## 4. Provider 实现细节

### 4.1 Qwen (通义千问)

**认证流程**：
1. 用户提供 Cookie JSON（包含 `tongyi_sso_ticket`）
2. 验证：`GET https://api.qianwen.com/oapi/user/checkUserInfo`
3. 调用：`POST https://qianwen.biz.aliyun.com/dialog/conversation` (HTTP/2 SSE)

**请求格式**：
```json
{
  "action": "next",
  "mode": "chat",
  "model": "qwen-max-latest",
  "requestId": "<uuid>",
  "sessionId": "<uuid>",
  "sessionType": "text_chat",
  "userAction": "chat",
  "contents": [{ "role": "user", "contentType": "text", "content": "消息" }]
}
```

**响应格式**：SSE，每行 `data: {"contentType":"text","content":"...","incremental":false,...}`

### 4.2 Kimi (月之暗面)

**认证流程**：
1. 用户提供 `refresh_token`
2. 刷新：`POST https://kimi.moonshot.cn/api/auth/token/refresh`
3. 返回 `access_token` + `refresh_token`

**请求格式**：
```json
{
  "messages": [{"role": "user", "content": "消息"}],
  "refs": [],
  "use_search": false,
  "kimiplus_id": "kimi"
}
```

**响应格式**：SSE，`data: {"event":"cmpl","text":"..."}`

### 4.3 智谱清言 (ChatGLM)

**认证流程**：
1. 用户提供 `chatglm_refresh_token`
2. 刷新：`POST https://chatglm.cn/chatglm/user-api/user/refresh`
   - 需要 x-sign 签名
3. 返回 `accessToken`（有效期 24 小时，建议 1 小时刷新）

**签名算法**：
```javascript
const sign = MD5(`${timestamp}-${nonce}-8a1317a7468aa3ad86e997d08f3f31cb`);
// 所有请求都需要 X-Sign, X-Nonce, X-Timestamp headers
```

**请求格式**：
```json
{
  "assistant_id": "65940acff94777010aa6b796",
  "conversation_id": "",
  "project_id": "",
  "chat_type": "user_chat",
  "messages": [{"role": "user", "content": [{"type": "text", "text": "消息"}]}],
  "meta_data": {
    "cogview": {"rm_label_watermark": false},
    "channel": "", "draft_id": "",
    "chat_mode": "zero", "is_networking": false,
    "input_question_type": "xxxx", "is_test": false,
    "platform": "pc", "quote_log_id": ""
  }
}
```

**响应格式**：SSE，`data: {"parts":[{"content":"...","type":"text"}],"conversation_id":"..."}`

### 4.4 豆包 (Doubao)

**认证流程**：
1. 用户提供 `sessionid`（即 Cookie 中的 sessionid）
2. 无需刷新，直接使用

**Anti-bot 参数**（均可伪造）：
```javascript
const msToken = btoa(randomBytes(96));  // 随机 base64
const a_bogus = `mf-${randomString(34)}-${randomString(6)}`;  // 随机格式
```

**请求格式**：
```json
{
  "messages": [{
    "content": "{\"text\":\"消息\"}",
    "content_type": 2001,
    "attachments": [],
    "references": []
  }],
  "completion_option": {
    "is_regen": false,
    "with_suggest": true,
    "need_create_conversation": true,
    "launch_stage": 1,
    "is_replace": false,
    "is_delete": false,
    "message_from": 0,
    "event_id": "0"
  },
  "conversation_id": "0",
  "local_conversation_id": "local_16<14位随机数字>",
  "local_message_id": "<uuid>"
}
```

**查询参数**：
```
aid=497858&device_id=<random>&device_platform=web&language=zh
&pkg_type=release_version&real_aid=497858&region=CN
&samantha_web=1&sys_region=CN&version_code=20800
&web_id=<random>&msToken=<fake>&a_bogus=<fake>
```

**响应格式**：SSE，事件解析后提取文本内容

## 5. OpenAI 协议转换

### 5.1 请求映射

```
OpenAI 请求                →  Provider 请求
─────────────────────────────────────────────
model: "qwen-max"          →  Qwen provider, model: "qwen-max-latest"
model: "kimi"              →  Kimi provider, kimiplus_id: "kimi"
model: "glm-4-plus"        →  Zhipu provider, assistant_id: DEFAULT
model: "doubao"            →  Doubao provider, bot: default
messages: [{role, content}] →  Provider-specific format
stream: true               →  SSE 响应
```

### 5.2 响应映射

所有 Provider 的 SSE 响应统一转换为 OpenAI Streaming 格式：
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion.chunk",
  "created": 1234567890,
  "model": "model-name",
  "choices": [{
    "index": 0,
    "delta": {"content": "回复内容片段"},
    "finish_reason": null
  }]
}
```

## 6. 模型映射

### Web 模式 Provider

| OpenAI model 名称 | Provider | 实际模型/标识 |
|-------------------|----------|---------|
| `qwen-max` / `qwen-plus` / `qwen-turbo` / `qwen-long` | Qwen | qwen-{variant}-latest |
| `kimi` / `moonshot` | Kimi | kimi (default) |
| `kimi-k1` / `k1` | Kimi | k1 |
| `glm-4` / `chatglm` | 智谱 | 65940acff94777010aa6b796 |
| `glm-4-zero` / `glm-zero` | 智谱 | 676411c38945bbc58a905d31 |
| `doubao` / `doubao-pro` | 豆包 | default bot |
| `deepseek` / `deepseek-chat` / `deepseek-v3` | DeepSeek | deepseek_chat |
| `deepseek-r1` / `deepseek-reasoner` | DeepSeek | deepseek_chat (thinking=true) |
| `deepseek-code` / `deepseek-coder` | DeepSeek | deepseek_code |
| `hailuo` / `minimax` / `minimax-text` | 海螺AI | hailuo |
| `step` / `stepchat` / `step-2` / `step-flash` | StepChat | step |
| `spark` / `spark-ultra` / `spark-max` / `spark-pro` / `spark-lite` | 讯飞星火 | generalv3.5 等 |
| `metaso` / `metaso-concise` / `metaso-detail` / `metaso-research` | 秘塔AI | concise / detail / research |
| `yuanbao` / `yuanbao-deepseek` / `yuanbao-hunyuan` | 腾讯元宝 | gpt_175B_0404 / deep_seek_v3 |

> 官方 API Key 付费渠道（百川/零一/商汤/天工）已移除，仅保留上述 Web 免费模式 Provider。

## 7. Token 管理

### 7.1 Token 缓存策略

```javascript
class TokenManager {
  // access_token 缓存，key: refresh_token → value: { accessToken, expiresAt }
  // 智谱: 24h 有效期，建议 1h 刷新
  // Kimi: 有效期较短，自动刷新
  // Qwen/豆包: 直接使用 cookie，无需刷新

  async getToken(provider, refreshToken) {
    const cached = this.cache.get(key);
    if (cached && !isExpired(cached)) return cached.accessToken;
    return await this.refresh(provider, refreshToken);
  }
}
```

### 7.2 Token 轮换

多账号场景下，按轮询方式使用不同 token，避免单一 token 频率过高。

## 8. 部署方式

### 8.1 桌面模式（Tauri）

由 Tauri 应用启动 Node.js sidecar 进程，监听本地端口。

### 8.2 Docker 模式

在 Docker compose 中增加 cn-providers 服务：

```yaml
services:
  cn-providers:
    build: ./cn-providers
    ports:
      - "8046:8046"
    environment:
      - PORT=8046
```

## 9. 参考项目

- [LLM-Red-Team/glm-free-api](https://github.com/LLM-Red-Team/glm-free-api) - 智谱清言逆向 API
- [LLM-Red-Team/doubao-free-api](https://github.com/LLM-Red-Team/doubao-free-api) - 豆包逆向 API
- [LLM-Red-Team/kimi-free-api](https://github.com/LLM-Red-Team/kimi-free-api) - Kimi 逆向 API

## 10. 会话记录与清理

### 10.1 设计原则
- 每次调用 Provider API 创建新对话后，**记录自己创建的会话 ID**
- **只删除自己创建的会话，绝不删除用户通过浏览器创建的会话**
- 对话完成后（SSE 流结束），通过记录的 conversation_id 异步删除
- 如果删除失败，记录到日志并在下次启动时重试

### 10.2 会话清理 API

| Provider | 删除端点 | 参数 |
|----------|---------|------|
| Qwen | `DELETE /dialog/session` | `sessionId` query |
| Kimi | `DELETE /api/chat/{conversationId}` | 路径参数 |
| 智谱 | `POST /chatglm/backend-api/assistant/conversation/delete` | `{ assistant_id, conversation_id }` |
| 豆包 | `POST /samantha/thread/delete` | `{ conversation_id }` |
| DeepSeek | `DELETE /api/v0/chat_session/{sessionId}` | 路径参数 |
| 海螺AI | `DELETE /api/chat/{convId}` | 路径参数 |
| StepChat | `DELETE /api/chat/{convId}` | 路径参数 |
| 讯飞星火 | `POST /iflygpt-chat/u/chat_list/delete` | `{ chatListId }` |
| 秘塔AI | N/A（搜索模式，无显式删除） | — |
| 腾讯元宝 | `POST /api/chat/delete` | `{ chatId }` |
| 百川/Yi/商汤/天工 | N/A（API Key 模式，无会话概念） | — |

### 10.3 实现

```javascript
class ConversationTracker {
  // 只记录 sidecar 自己创建的会话，不涉及用户通过浏览器创建的会话
  myConversations = new Map(); // convId → { provider, createdAt, token }

  recordCreated(convId, provider, token) {
    // 仅在 sidecar 发起请求并从 SSE 响应中获取到 conversation_id 时调用
    this.myConversations.set(convId, { provider, createdAt: Date.now(), token });
  }

  async onStreamComplete(convId) {
    const info = this.myConversations.get(convId);
    if (!info) return; // 不是我们创建的，不删除
    try {
      await info.provider.deleteConversation(convId, info.token);
      this.myConversations.delete(convId);
    } catch(e) {
      logger.warn(`会话清理失败: ${convId}`, e);
    }
  }

  async cleanupStale() {
    // 只清理 sidecar 自己创建且超过 1 小时未清理的会话
    for (const [id, info] of this.myConversations) {
      if (Date.now() - info.createdAt > 3600000) {
        await info.provider.deleteConversation(id, info.token).catch(() => {});
        this.myConversations.delete(id);
      }
    }
  }
}
```

## 11. 验证状态

### 基础设施（全部通过）
- ✅ 健康检查 `/health`
- ✅ Token 注册/删除 `/v1/tokens`
- ✅ 模型列表 `/v1/models`（动态跟随已注册 token）
- ✅ 错误处理（400 缺字段、404 未知模型）
- ✅ 多 Provider 并行注册
- ✅ 语法检查全部 21 个 .mjs 文件

### Provider（需真实 Token 验证）
- Qwen/Kimi/智谱/豆包：已在逆向阶段通过 Playwright 实际验证
- DeepSeek/海螺AI/StepChat/讯飞/秘塔/元宝：代码审查完成，待真实 Token 验证
- 百川/Yi/商汤/天工：官方 API 代理模式，接口标准化，待 API Key 验证

## 12. 已知风险

1. **Provider API 变更**：Web API 可能随时更新，需要持续维护
2. **账号封禁**：频繁调用可能导致账号被封
3. **签名 secret 更新**：智谱的 MD5 secret `8a1317a7468aa3ad86e997d08f3f31cb` 可能更新
4. **豆包 a_bogus 验证**：未来可能启用严格验证，需关注
5. **Token 过期**：智谱 access_token 24h 过期，需定时刷新
6. **会话泄漏**：如果清理失败，会话会残留在用户的聊天列表中
7. **DeepSeek Cloudflare**：可能需要 `cf_clearance` cookie 配合使用
8. **DeepSeek PoW 难度**：SHA3-256 暴力求解可能随难度增大变慢
9. **讯飞星火 WebSocket**：Web 端聊天核心使用 WebSocket，当前实现基于 HTTP 内部 API
10. **wreq-js 退出 assertion**：Native addon 在 Windows 进程退出时偶发 libuv assertion，不影响功能
