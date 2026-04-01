# CN Providers 逆向代理需求文档

## 1. 项目目标

将标准 OpenAI 协议请求转换为中国各 AI 厂商的 Web 端请求（Cookie/Token 登录，免费模式），再将厂商的 Web 响应转换回 OpenAI 格式响应。

## 2. 核心架构

```
Rust 主进程 (OpenAI 协议)
    ↓ 转发
Node.js Sidecar (端口 8046)
    ↓ 协议转换
各厂商 Web API (Cookie 认证)
```

- **Rust 侧**：只看到 OpenAI 协议的入出，负责账号池管理、速率限制、模型映射路由
- **Node.js 侧**：负责 OpenAI→Web 的协议转换、Cookie/Token 管理、SSE 流转换
- 每个厂商的具体实现细节收敛在各自的 Provider 模块中

## 3. 功能要求

### 3.1 仅支持 Web 模式
- **只需要** Web 模式（Cookie/Token 登录，免费）
- **不需要** OpenAI API Key 模式
- 已删除的 API Key 渠道：百川智能、零一、商汤、天工

### 3.2 认证方式
- 从浏览器 CDP (Chrome DevTools Protocol) 提取 Cookie/Token
- 已解析的认证信息**必须保存到本地**（`~/.antigravity_tools/cn_provider_tokens.json`）
- 只有 Cookie 过期时才重新提取，避免频繁操作
- 支持自动刷新 Token（如 Kimi 的 refresh_token）

### 3.3 模型管理（重要）
- 各厂商支持多模型选择（如 Qwen 支持 qwen3.5、qwen3-max 等）
- 模型映射关系需要可配置、可扩展
- 启动时尝试自动获取厂商最新模型列表（如果 API 支持）
- 模型信息**必须与 Rust 服务的模型管理体系兼容**
- 不能只考虑能不能调用，需要结合 Rust 服务完整功能来设计

### 3.4 HTTP 请求
- 所有出站 HTTP 请求**必须使用 `wreq-js`**（Rust 驱动的 TLS 指纹伪装）
- 避免被反爬系统识别为非浏览器请求

### 3.5 会话管理
- 必须跟踪所有 sidecar 创建的会话
- 测试/使用完毕后自动删除创建的会话
- 避免在用户的真实账号中留下垃圾会话

### 3.6 最小侵入
- Node.js sidecar 独立于 Rust 主代码库
- 代码放在 `cn-providers/` 目录下
- 不修改 Rust 核心代码，通过配置和端口转发集成

### 3.7 响应格式支持（重要）
- Web 端响应通常是流式的（SSE）
- Rust 对外暴露的 OpenAI 接口需要**同时支持流式和非流式**响应
- 同时需要支持**思考模式和非思考模式**（如 Spark 的 deep_x1、DeepSeek 的思考链）
- CN Provider 的响应转换**必须全面覆盖**这些模式组合
- 思考过程内容默认**不输出给最终用户**（过滤掉）

### 3.8 账号池策略
- 需要控制单个账号的请求频率
- Rust 进程统一实现账号池的管理和分配
- 支持多账号轮询、负载均衡

## 4. 测试规范

### 4.1 测试消息
- **禁止**发送 "你是谁"、"测试"、"测试请求" 等明显的机器人消息
- 使用自然、有意义的问题，如：
  - "请用三句话介绍一下中国的四大发明"
  - "帮我算一下 123 × 456 等于多少"
  - "推荐一本适合初学者的编程书籍"

### 4.2 调试数据保存
- 每个 Provider 验证过程中，必须将以下信息保存到 `cn-providers/debug/` 目录：
  - 完整请求头 (headers)
  - 请求报文 (body)
  - 完整响应头
  - 响应报文
  - Cookie
  - localStorage（如果相关）

### 4.3 频率控制
- 频繁测试会导致限流，测试前先分析代码逻辑确保正确
- 不要盲目重复测试，先修复代码再测试
- 出现限流时等待足够时间后再重试

## 5. 逆向开发规范

### 5.1 API 发现方式
- **优先使用 Playwright UI 操作**（点击按钮、输入文字、发送消息）来捕获实际网络请求
- **不要先分析 JS 代码**，除非 UI 操作无法获取到需要的信息
- JS 分析仅用于理解签名算法等特殊需求

### 5.2 反爬处理
- 签名算法需要完整逆向实现（如 Zhipu X-Sign、Doubao a_bogus）
- 不要用随机值替代服务端可能验证的字段
- 需要先调研逆向复杂度，确认后再决定是否实现

### 5.3 浏览器操作
- 使用 Edge 浏览器的 CDP 端口 9222
- 操作浏览器进行逆向抓包时，由 AI 主导操作，用户配合
- Chrome 9222 端口可能只绑定 IPv6，Edge 同时绑定 IPv4/IPv6

## 6. 目标厂商清单

| 厂商 | Provider 名称 | 状态 | 备注 |
|------|-------------|------|------|
| 通义千问 | qwen | ✅ 已完成 | pluginCall 过滤 |
| DeepSeek | deepseek | ✅ 已完成 | WASM PoW |
| Kimi | kimi | ✅ 已完成 | kimi-auth JWT (www.kimi.com) |
| 智谱清言 | zhipu | ✅ 已完成 | X-Sign MD5 签名 |
| 小米 MOMI | momi | ✅ 已完成 | Cookie 认证 |
| 讯飞星火 | spark | ✅ 已完成 | 新 API + base64 SSE + deep_x1 过滤 |
| 豆包 | doubao | ✅ 已完成 | a_bogus/msToken 服务端不强制验证 |
| StepChat | step | ✅ 已完成 | Connect Protocol + JWT 过期预检 |
| 秘塔搜索 | metaso | ⚠️ 限流 | Next.js RSC 迁移，429 限流 |
| 海螺AI (MiniMax) | hailuo | ✅ 已完成 | Cookie 认证 |
| 腾讯元宝 | yuanbao | ✅ 已完成 | Agent 架构重写 |

## 7. 文档维护要求

- 在 `mydoc/cn-providers-reverse/` 下维护所有逆向文档
- 每个 Provider 的逆向分析记录单独文件
- 任务计划和进度跟踪在 `PROGRESS.md` 中维护
- 中间产出物（抓包数据、签名分析等）保存在 `cn-providers/debug/`
