# CN Providers 逆向代理 - 任务计划与进度

## 当前状态（2026-04-01 更新）

### 已完成 ✅

| 任务 | 完成时间 | 技术要点 |
|------|---------|---------|
| Qwen Provider | 03-31 | SSE `contents[0].content` 格式；pluginCall 过滤 |
| DeepSeek Provider | 03-31 | WebAssembly PoW（SHA3-256）；`createIdExtractingPassthrough` 流处理 |
| Kimi Provider | 03-31 | kimi-auth JWT (www.kimi.com)；access_token 直接使用 |
| Zhipu Provider | 04-01 | X-Sign = MD5(modifiedTimestamp-nonce-salt)；content 数组格式适配 |
| MOMI Provider | 03-31 | Cookie 认证；dialogId 提取；`<think>` 标签过滤 |
| Step Provider | 03-31 | Connect Protocol (gRPC-web) 二进制帧编解码 |
| Spark Provider | 04-01 | **新 API 完全重写**：multipart/form-data + base64 SSE + `<deep_x1>` 过滤 |
| Yuanbao Provider | 04-01 | **完全重写**：Agent 架构 + SSE `{type,msg}` + Cookie 解析 |
| Token 持久化 | 03-31 | `~/.antigravity_tools/cn_provider_tokens.json` |
| TransformStream 改造 | 03-31 | 替换所有 `tee()` 为 `createIdExtractingPassthrough` |
| CDP 连接修复 | 04-01 | 从 Playwright 切换到 puppeteer-core |
| **SSE 胶水层解耦** | 04-01 | `native-to-openai.mjs` → `sse-registry.mjs` + 各 provider 注册 |
| **Step JWT 过期预检** | 04-01 | 解析 `Oasis-Token` JWT exp，提前 5min 标记过期 |
| **HTTP 超时保护** | 04-01 | `httpRequest` 默认 30s 超时；SSE 请求 `timeoutMs:0` |
| **Rust CN Provider 路由** | 04-01 | `cn_provider.rs` + `CnProviderConfig` + 模型列表合并 |

### 待处理 📋

| 任务 | 优先级 | 备注 |
|------|--------|------|
| 调研 Doubao a_bogus/msToken | 高 | 确认逆向复杂度后决定是否实现 |
| Chat2API Git Submodule 集成 | 中 | axios-to-wreq 适配器 |
| 逆向文档 + 通用抓取 SKILL | 低 | 通用抓取能力 |
| Metaso 限流恢复后验证 | 低 | 429 限流中 |

## 逆向分析记录

### Zhipu X-Sign 算法（04-01 完成）
- **位置**: webpack 模块 93990，函数 `w()` (导出名 `o0`)
- **算法**:
  1. `timestamp` = 对 `Date.now().toString()` 做校验位替换（倒数第二位替换为 `(数字和 - 原倒数第二位) % 10`）
  2. `nonce` = UUID v4 去横杠（32位 hex）
  3. `sign` = MD5(`{timestamp}-{nonce}-8a1317a7468aa3ad86e997d08f3f31cb`)
- **其他必需 headers**: `App-Name: chatglm`, `X-Device-Id`, `X-App-Platform: pc`, `X-App-Version: 0.0.1`
- **content 格式变更**: `parts[0].content` 从字符串改为数组 `[{type:"text", text:"...", tool_calls:{}}]`

### DeepSeek PoW（03-31 完成）
- SHA3-256 WASM 暴力搜索
- 挑战格式: `{algorithm, challenge, salt, difficulty, expire_at}`
- 解法: 加载官方 `sha3_wasm_bg.wasm`

### Step Connect Protocol（03-31 完成）
- gRPC-web 变体，二进制帧编码
- URL 从 `yuewen.cn` 迁移到 `stepfun.com`

### Spark Provider 逆向（04-01 完成）
- 旧 API (`iflygpt-chat/u/chat_list/*`, `iflygpt-chat/u/chat/send_text`) 全部 404
- **通过 puppeteer-core UI 操作捕获到新 API**（输入消息 + 点击发送）
- **创建对话**: `POST /iflygpt/u/chat-list/v1/create-chat-list` (JSON `{}`)
- **发送消息**: `POST /iflygpt-chat/u/chat_message/chat` (multipart/form-data)
  - 字段: fd, chatId, text, isBot, capabilities, clientType, options, GtToken
  - `GtToken` 可以为空（GeeTest 不强制验证）
  - `options`: `{"chatOption":{"thinkPattern":"auto"}}`
- **SSE 格式**: `data:<base64编码文本>`，每个事件是一个文本片段
  - 结束标记: `data:<end>`
  - 会话ID: `data:cht...@...<sid>`
  - 深度思考: `<deep_x1>` 前缀的 JSON 事件（已过滤）
  - 插件推荐: ` ```question_type_recommand_json...` （已跳过）
- **删除 API**: 旧路径全部 404，暂为 best-effort 处理
- 认证: `ssoSessionId` Cookie

### Doubao 现状
- `event_type: 2005` 表示限流/封禁 (`block` message)
- `a_bogus` 和 `msToken` 是否被验证待调研

### Metaso 现状
- 迁移到 Next.js RSC 架构
- 新端点: `POST /api/search/chat`
- 新账号 429 限流严重

### Yuanbao Provider 逆向（04-01 完成）
- **通过 puppeteer-core UI 操作（Quill 编辑器 + icon-send 按钮）捕获完整 API 链路**
- **Chat API**: `POST /api/chat/{client-generated-uuid}`
  - Content-Type: `text/plain;charset=UTF-8`（body 实际为 JSON）
  - 必需头: `X-AgentID: naQivTmsDa`, `X-ID`, `T-UserID`（= `hy_user` cookie）, `X-device-id`/`X-HY93`（= `_qimei_uuid42` cookie）
  - 可选头（服务端不校验）: `X-Uskey`, `X-Bus-Params-Md5`
  - 请求体: `{model, prompt, chatModelId, agentId, supportFunctions, chatModelExtInfo, version:"v2", ...}`
- **SSE 格式**: `data: {"type":"text","msg":"增量文本"}`
  - 结束: `data: [DONE]`
  - 元数据: `data: {"type":"meta","stopReason":"stop",...}`
  - 提示: `data: {"type":"tips",...}` + `data: [plugin: ]` + `data: [MSGINDEX:N]` + `data: [TRACEID:...]`（均已忽略）
- **模型列表**: `POST /api/agent/model/list` body=`{agentId}`
  - 返回: `hunyuan_gpt_175B_0404`(Hunyuan), `deep_seek_v3`(DeepSeek), `hunyuan_t1`(深度思考T1), `deep_seek`(DeepSeek R1)
- **对话ID**: 客户端生成 UUID，不需要从流中提取
- **删除 API**: 未找到有效端点（`/api/user/agent/conversation/delete` 返回 404），best-effort 处理
- **认证**: Cookie（`hy_user` + `hy_token` + `_qimei_uuid42`），无额外签名

## 预存代码问题（已全部修复）

1. ~~**`native-to-openai.mjs` 中的 DEBUG 日志仍然活跃**~~ ✅ 解耦重构时已移除
2. ~~**所有 HTTP 请求缺少超时设置**~~ ✅ `httpRequest` 已添加 30s 默认超时 + SSE 请求 `timeoutMs:0`
3. ~~**Step JWT 30 分钟 TTL**~~ ✅ 已实现 JWT `exp` 预检 + `markExpired` 自动标记
4. ~~**Yuanbao API 已过时**~~ ✅ 已在 04-01 完全重写
5. ~~**DeepSeek userToken 格式变更**~~ ✅ 提取脚本已处理 JSON wrapper 格式
