# cn-providers 工具模块任务

- [x] 流式 chat `httpRequest` 增加 `timeoutMs: 0`（11 个 provider）

- [x] `src/config.mjs` 环境变量配置
- [x] `src/http-client.mjs` wreq-js 封装（createSession + session.fetch，lazy init）
- [x] `src/utils/sign.mjs` 智谱签名
- [x] `src/utils/sse-parser.mjs` SSE 解析
- [x] `src/utils/token-manager.mjs` Token 缓存与刷新
- [x] `src/utils/conversation-tracker.mjs` 会话追踪清理
- [x] `src/providers/qwen.mjs` 通义千问 Web API Provider（SSE + 会话删除）
- [x] `src/providers/kimi.mjs` Kimi（月之暗面）refresh + 建会话 + SSE
- [x] `src/providers/zhipu.mjs` 智谱清言 X-Sign 刷新 + assistant/stream SSE
- [x] `src/providers/doubao.mjs` 豆包 sessionid + samantha completion SSE
