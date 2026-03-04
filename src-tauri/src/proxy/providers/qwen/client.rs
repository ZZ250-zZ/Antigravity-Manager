// Qwen HTTP 客户端 - 处理与 Qwen API 的通信

use super::QwenSignatures;
use super::signer::{CookieData, parse_cookies_from_token};
use anyhow::{anyhow, Result};
use bytes::Bytes;
use futures::Stream;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE, COOKIE, USER_AGENT};
use serde_json::Value;

/// Qwen API 客户端
pub struct QwenClient {
    http: reqwest::Client,
    base_url: String,
}

impl QwenClient {
    /// 创建新的客户端
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .connect_timeout(std::time::Duration::from_secs(30))
                .pool_max_idle_per_host(10)
                .build()
                .expect("Failed to build HTTP client"),
            base_url: "https://chat2.qianwen.com".to_string(),
        }
    }

    /// 创建带自定义配置的客户端
    pub fn with_timeout(timeout_secs: u64) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(timeout_secs))
                .connect_timeout(std::time::Duration::from_secs(30))
                .pool_max_idle_per_host(10)
                .build()
                .expect("Failed to build HTTP client"),
            base_url: "https://chat2.qianwen.com".to_string(),
        }
    }

    /// 发送聊天请求 (流式响应)
    /// 
    /// 参数:
    /// - access_token: 存储 Cookie JSON 的 access_token 字段
    /// - body: 请求体
    /// - signatures: 安全签名
    pub async fn chat_stream(
        &self,
        access_token: &str,
        body: &Value,
        signatures: &QwenSignatures,
    ) -> Result<impl Stream<Item = Result<Bytes, reqwest::Error>>> {
        // 从 access_token 解析 Cookie
        let cookies = parse_cookies_from_token(access_token)?;
        
        let url = format!("{}/api/v2/chat", self.base_url);
        let headers = self.build_headers(&cookies, signatures)?;

        tracing::debug!("[QwenClient] Sending chat request to {}", url);
        tracing::debug!("[QwenClient] Request body: {}", body.to_string());

        let response = self
            .http
            .post(&url)
            .headers(headers)
            .json(body)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(anyhow!(
                "Qwen API error: {} - {}",
                status,
                text
            ));
        }

        Ok(response.bytes_stream())
    }

    /// 获取模型列表
    pub async fn get_model_list(
        &self,
        access_token: &str,
        signatures: &QwenSignatures,
        device_id: &str,
    ) -> Result<Value> {
        let cookies = parse_cookies_from_token(access_token)?;
        
        let url = format!(
            "{}/api/v1/model/list?biz_id=ai_qwen&chat_client=h5&device=pc&fr=pc&pr=qwen&ut={}",
            self.base_url, device_id
        );
        let headers = self.build_headers(&cookies, signatures)?;

        let response = self
            .http
            .get(&url)
            .headers(headers)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(anyhow!("Failed to get model list: {} - {}", status, text));
        }

        let data: Value = response.json().await?;
        Ok(data)
    }

    /// 检查登录状态
    pub async fn check_login_status(&self, access_token: &str) -> Result<bool> {
        let cookies = parse_cookies_from_token(access_token)?;
        
        let url = format!("{}/api/v1/session/top/list", self.base_url);
        let cookie_header = cookies
            .iter()
            .map(|c| format!("{}={}", c.name, c.value))
            .collect::<Vec<_>>()
            .join("; ");

        let mut headers = HeaderMap::new();
        headers.insert(COOKIE, HeaderValue::from_str(&cookie_header)?);
        headers.insert(
            USER_AGENT,
            HeaderValue::from_static(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            ),
        );

        let response = self.http.get(&url).headers(headers).send().await?;

        // 如果返回 200 且没有重定向到登录页，则认为已登录
        Ok(response.status().is_success())
    }

    /// 验证Cookie有效性 - 调用用户信息接口
    /// 
    /// 接口: https://api.qianwen.com/growth/user/benefit/user/member/info
    /// 验证条件: 返回200 且 success=true
    /// 
    /// 使用 rquest 客户端以支持 TLS 指纹模拟（与 Chat 请求一致）
    pub async fn check_user_info(&self, access_token: &str) -> Result<bool> {
        use rquest::{Client, header};
        
        let start_time = std::time::Instant::now();
        let cookies = parse_cookies_from_token(access_token)?;
        
        // 从 Cookie 中提取关键字段
        let xsrf_token = cookies
            .iter()
            .find(|c| c.name == "XSRF-TOKEN")
            .map(|c| c.value.clone())
            .unwrap_or_default();
        
        let device_id = cookies
            .iter()
            .find(|c| c.name == "x-deviceid")
            .map(|c| c.value.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        
        // 使用 rquest 客户端（支持 TLS 指纹模拟）
        let client = Client::builder()
            .emulation(rquest_util::Emulation::Chrome123)
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| anyhow!("Failed to build rquest client: {}", e))?;
        
        // 使用 api.qianwen.com 域名
        // ut 参数是从 Cookie 中提取的 x-deviceid
        let url = format!(
            "https://api.qianwen.com/growth/user/benefit/user/member/info?biz_id=ai_qwen&chat_client=h5&device=pc&fr=pc&pr=qwen&ut={}",
            device_id
        );
        
        let cookie_header = cookies
            .iter()
            .map(|c| format!("{}={}", c.name, c.value))
            .collect::<Vec<_>>()
            .join("; ");

        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::COOKIE,
            header::HeaderValue::from_str(&cookie_header)
                .map_err(|e| anyhow!("Invalid cookie header: {}", e))?,
        );
        headers.insert(
            header::USER_AGENT,
            header::HeaderValue::from_static(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
            ),
        );
        headers.insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("application/json"),
        );
        headers.insert(
            "accept",
            header::HeaderValue::from_static("application/json, text/plain, */*"),
        );
        headers.insert(
            "accept-language",
            header::HeaderValue::from_static("zh-CN,zh;q=0.9,en;q=0.8"),
        );
        headers.insert(
            "referer",
            header::HeaderValue::from_static("https://www.qianwen.com/"),
        );
        // 添加平台相关 headers（与浏览器请求一致）
        headers.insert(
            "x-platform",
            header::HeaderValue::from_static("pc_tongyi"),
        );
        headers.insert(
            "x-deviceid",
            header::HeaderValue::from_str(&device_id)
                .map_err(|e| anyhow!("Invalid device_id: {}", e))?,
        );
        if !xsrf_token.is_empty() {
            headers.insert(
                "x-xsrf-token",
                header::HeaderValue::from_str(&xsrf_token)
                    .map_err(|e| anyhow!("Invalid xsrf_token: {}", e))?,
            );
        }
        // 添加 sec-ch-ua headers（浏览器指纹的一部分）
        headers.insert(
            "sec-ch-ua",
            header::HeaderValue::from_static("\"Chromium\";v=\"145\", \"Not:A-Brand\";v=\"99\""),
        );
        headers.insert(
            "sec-ch-ua-mobile",
            header::HeaderValue::from_static("?0"),
        );
        headers.insert(
            "sec-ch-ua-platform",
            header::HeaderValue::from_static("\"Windows\""),
        );

        // 请求体（与浏览器请求一致）
        let request_body = r#"{"clientChannel": "PC"}"#;

        // ========== DEBUG 日志开始 ==========
        tracing::debug!("[check_user_info] ========== HTTP Request Details ==========");
        tracing::debug!("[check_user_info] Method: POST");
        tracing::debug!("[check_user_info] URL: {}", url);
        tracing::debug!("[check_user_info] TLS Emulation: Chrome123 (rquest)");
        tracing::debug!("[check_user_info] Cookie count: {}", cookies.len());
        tracing::debug!("[check_user_info] XSRF-Token from cookie: {}", if xsrf_token.is_empty() { "(not found)" } else { "(found)" });
        tracing::debug!("[check_user_info] DeviceID from cookie: {}", device_id);
        
        // 打印完整的请求头（Cookie 只显示名称列表）
        tracing::debug!("[check_user_info] Request Headers:");
        for (name, value) in headers.iter() {
            let val_str = value.to_str().unwrap_or("(binary)");
            if name.as_str().to_lowercase() == "cookie" {
                let cookie_names: Vec<&str> = val_str.split(';').map(|c| c.trim().split('=').next().unwrap_or("")).collect();
                tracing::debug!("  {}: {:?}", name, cookie_names);
            } else {
                tracing::debug!("  {}: {}", name, val_str);
            }
        }
        
        tracing::debug!("[check_user_info] Request Body: {}", request_body);
        tracing::debug!("[check_user_info] ========== Sending Request ==========");
        // ========== DEBUG 日志结束 ==========
        
        // 使用 POST 请求（405 错误表明 GET 不被允许）
        let response = client.post(&url).headers(headers).body(request_body).send().await
            .map_err(|e| anyhow!("Request failed: {}", e))?;

        let status = response.status();
        let elapsed = start_time.elapsed();
        
        // ========== 响应 DEBUG 日志开始 ==========
        tracing::debug!("[check_user_info] ========== HTTP Response Details ==========");
        tracing::debug!("[check_user_info] Status: {}", status);
        tracing::debug!("[check_user_info] Duration: {:?}", elapsed);
        
        // 打印响应头
        tracing::debug!("[check_user_info] Response Headers:");
        for (name, value) in response.headers().iter() {
            let val_str = value.to_str().unwrap_or("(binary)");
            tracing::debug!("  {}: {}", name, val_str);
        }
        // ========== 响应 DEBUG 日志结束 ==========

        // 检查返回状态码
        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_default();
            tracing::warn!("[check_user_info] Non-200 response: {} - {}", status, error_text);
            tracing::debug!("[check_user_info] Cookie check result: false (HTTP error)");
            return Ok(false);
        }

        // 解析 JSON 响应，检查 success 字段
        let body: Value = response.json().await
            .map_err(|e| anyhow!("Parse response failed: {}", e))?;
        
        tracing::debug!("[check_user_info] Response Body: {:?}", body);
        
        let success = body.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
        
        tracing::debug!("[check_user_info] Parsed 'success' field: {}", success);
        tracing::debug!("[check_user_info] Cookie check result: {}", success);
        tracing::debug!("[check_user_info] ========== End of Request ==========");
        Ok(success)
    }

    /// 构建请求头
    fn build_headers(
        &self,
        cookies: &[CookieData],
        signatures: &QwenSignatures,
    ) -> Result<HeaderMap> {
        let mut headers = HeaderMap::new();

        // Cookie
        let cookie_header = cookies
            .iter()
            .map(|c| format!("{}={}", c.name, c.value))
            .collect::<Vec<_>>()
            .join("; ");
        headers.insert(COOKIE, HeaderValue::from_str(&cookie_header)?);

        // Content-Type
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        // User-Agent
        headers.insert(
            USER_AGENT,
            HeaderValue::from_static(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
            ),
        );

        // XSRF Token
        headers.insert(
            "x-xsrf-token",
            HeaderValue::from_str(&signatures.csrf_token)?,
        );

        // Platform headers
        headers.insert("x-platform", HeaderValue::from_static("pc_tongyi"));
        headers.insert("x-deviceid", HeaderValue::from_static("web_device_id"));
        headers.insert("x-chat-id", HeaderValue::from_static("default"));

        // 安全签名 (如果存在)
        if !signatures.bx_et.is_empty() {
            headers.insert("bx_et", HeaderValue::from_str(&signatures.bx_et)?);
        }
        if !signatures.bx_umidtoken.is_empty() {
            headers.insert(
                "bx-umidtoken",
                HeaderValue::from_str(&signatures.bx_umidtoken)?,
            );
        }

        // 其他常见 headers
        headers.insert("accept", HeaderValue::from_static("application/json, text/event-stream, text/plain, */*"));
        headers.insert("accept-language", HeaderValue::from_static("zh-CN,zh;q=0.9,en;q=0.8"));
        headers.insert("origin", HeaderValue::from_static("https://www.qianwen.com"));
        headers.insert("referer", HeaderValue::from_static("https://www.qianwen.com/"));

        Ok(headers)
    }

    /// 生成设备 ID
    pub fn generate_device_id() -> String {
        uuid::Uuid::new_v4().to_string().replace("-", "")
    }

    /// 生成请求 ID
    pub fn generate_req_id() -> String {
        uuid::Uuid::new_v4().to_string()
    }

    /// 生成会话 ID
    pub fn generate_session_id() -> String {
        uuid::Uuid::new_v4().to_string()
    }
}

impl Default for QwenClient {
    fn default() -> Self {
        Self::new()
    }
}

/// 解析 SSE 流数据
pub fn parse_sse_chunk(chunk: &Bytes) -> Vec<Value> {
    let mut messages = Vec::new();
    let text = String::from_utf8_lossy(chunk);

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        if line.starts_with("data: ") {
            let data = &line[6..];
            if data == "[DONE]" {
                continue;
            }
            if let Ok(json) = serde_json::from_str::<Value>(data) {
                messages.push(json);
            }
        }
    }

    messages
}

/// 从 SSE 消息中提取文本内容
pub fn extract_content_from_message(msg: &Value) -> Option<String> {
    msg.get("data")
        .and_then(|d| d.get("messages"))
        .and_then(|m| m.as_array())
        .and_then(|arr| arr.first())
        .and_then(|first| first.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
}
