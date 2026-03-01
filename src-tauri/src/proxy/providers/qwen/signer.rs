// 签名管理器 - 负责获取和管理 Qwen 安全签名
// 签名包括: bx_et, bx_umidtoken, csrf_token

use super::QwenSignatures;
use anyhow::{anyhow, Result};

/// Cookie 数据项
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CookieData {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires: Option<i64>,
}

/// 从 access_token 字段解析 Cookie
pub fn parse_cookies_from_token(access_token: &str) -> Result<Vec<CookieData>> {
    serde_json::from_str(access_token)
        .map_err(|e| anyhow!("Failed to parse cookies from token: {}", e))
}

/// 将 Cookie 序列化到 access_token 字段
pub fn serialize_cookies_to_token(cookies: &[CookieData]) -> String {
    serde_json::to_string(cookies).unwrap_or_default()
}
use dashmap::DashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 缓存的签名
struct CachedSignature {
    signatures: QwenSignatures,
    cached_at: Instant,
    ttl: Duration,
}

impl CachedSignature {
    fn new(signatures: QwenSignatures, ttl: Duration) -> Self {
        Self {
            signatures,
            cached_at: Instant::now(),
            ttl,
        }
    }

    fn is_expired(&self) -> bool {
        self.cached_at.elapsed() > self.ttl
    }
}

/// 签名管理器
pub struct Signer {
    /// 签名缓存 (account_id -> CachedSignature)
    cache: Arc<DashMap<String, CachedSignature>>,
    /// 默认缓存时间
    default_ttl: Duration,
    /// HTTP 客户端
    client: reqwest::Client,
}

impl Signer {
    /// 创建新的签名管理器
    pub fn new() -> Self {
        Self {
            cache: Arc::new(DashMap::new()),
            default_ttl: Duration::from_secs(300), // 5 分钟
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
        }
    }

    /// 创建带自定义 TTL 的签名管理器
    pub fn with_ttl(ttl_secs: u64) -> Self {
        Self {
            cache: Arc::new(DashMap::new()),
            default_ttl: Duration::from_secs(ttl_secs),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
        }
    }

    /// 获取签名 (优先缓存)
    /// 
    /// 参数:
    /// - account_id: 账号 ID
    /// - access_token: 存储 Cookie JSON 的 access_token 字段
    pub async fn get_signatures(
        &self,
        account_id: &str,
        access_token: &str,
    ) -> Result<QwenSignatures> {
        // 检查缓存
        if let Some(cached) = self.cache.get(account_id) {
            if !cached.is_expired() {
                tracing::debug!("[QwenSigner] Using cached signatures for account {}", account_id);
                return Ok(cached.signatures.clone());
            }
        }

        // 从 access_token 解析 Cookie
        let cookies = parse_cookies_from_token(access_token)?;

        // 获取新签名
        let signatures = self.fetch_signatures(&cookies).await?;

        // 更新缓存
        self.cache.insert(
            account_id.to_string(),
            CachedSignature::new(signatures.clone(), self.default_ttl),
        );

        Ok(signatures)
    }

    /// 强制刷新签名
    pub async fn refresh_signatures(
        &self,
        account_id: &str,
        access_token: &str,
    ) -> Result<QwenSignatures> {
        self.cache.remove(account_id);
        self.get_signatures(account_id, access_token).await
    }

    /// 清除账号缓存
    pub fn clear_cache(&self, account_id: &str) {
        self.cache.remove(account_id);
    }

    /// 清除所有缓存
    pub fn clear_all_cache(&self) {
        self.cache.clear();
    }

    /// 从 Qwen 网站获取签名
    /// 
    /// 实际实现方案：
    /// 1. 使用 Playwright 访问网站
    /// 2. 注入 Cookie
    /// 3. 执行 JS 提取签名: window.__awsc_et__.getETToken()
    /// 
    /// 当前使用模拟实现，实际需要接入 Playwright
    async fn fetch_signatures(&self, cookies: &[CookieData]) -> Result<QwenSignatures> {
        // 提取 csrf_token (后续 Playwright 实现会使用)
        let _csrf_token = cookies
            .iter()
            .find(|c| c.name == "XSRF-TOKEN")
            .map(|c| c.value.clone())
            .ok_or_else(|| anyhow!("XSRF-TOKEN not found in cookies"))?;

        // TODO: 实际实现需要通过 Playwright 获取 bx_et 和 bx_umidtoken
        // 临时使用模拟值，实际使用时需要替换
        let signatures = self.fetch_signatures_via_playwright(cookies).await?;

        Ok(signatures)
    }

    /// 通过 Playwright 获取签名
    /// 
    /// 注意：这是预留接口，实际需要接入 Playwright
    /// 方案：
    /// 1. 启动 Playwright 浏览器
    /// 2. 访问 https://www.qianwen.com/
    /// 3. 注入 Cookie
    /// 4. 执行 JS:
    ///    ```javascript
    ///    () => ({
    ///        bx_et: window.__awsc_et__?.getETToken(),
    ///        bx_umidtoken: window.__etModule?.getETToken(),
    ///        csrf_token: window.csrfToken,
    ///    })
    ///    ```
    /// 5. 返回签名
    async fn fetch_signatures_via_playwright(&self, cookies: &[CookieData]) -> Result<QwenSignatures> {
        // 提取 csrf_token
        let csrf_token = cookies
            .iter()
            .find(|c| c.name == "XSRF-TOKEN")
            .map(|c| c.value.clone())
            .ok_or_else(|| anyhow!("XSRF-TOKEN not found in cookies"))?;

        // 尝试从 Tauri 命令调用 Playwright
        // 实际实现应该通过 Tauri command 调用 Python 脚本
        // 或者使用 rust 的 playwright 绑定
        
        // 临时方案：返回需要刷新的标记
        // 实际使用时应该通过前端 Playwright 获取签名后传入
        tracing::warn!("[QwenSigner] Playwright integration not yet implemented");
        tracing::warn!("[QwenSigner] Please use external Playwright script to get signatures");

        // 临时返回空签名，实际使用时需要替换
        Ok(QwenSignatures {
            bx_et: String::new(),
            bx_umidtoken: String::new(),
            csrf_token,
            timestamp: chrono::Utc::now().timestamp_millis(),
        })
    }

    /// 设置签名 (由外部 Playwright 脚本调用)
    pub fn set_signatures(
        &self,
        account_id: &str,
        bx_et: String,
        bx_umidtoken: String,
        csrf_token: String,
    ) {
        let signatures = QwenSignatures {
            bx_et,
            bx_umidtoken,
            csrf_token,
            timestamp: chrono::Utc::now().timestamp_millis(),
        };
        self.cache.insert(
            account_id.to_string(),
            CachedSignature::new(signatures, self.default_ttl),
        );
    }
}

impl Default for Signer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_signature_expired() {
        let sig = QwenSignatures {
            bx_et: "test".to_string(),
            bx_umidtoken: "test".to_string(),
            csrf_token: "test".to_string(),
            timestamp: chrono::Utc::now().timestamp_millis() - 6 * 60 * 1000, // 6 分钟前
        };
        assert!(sig.is_expired());
    }

    #[test]
    fn test_signature_not_expired() {
        let sig = QwenSignatures {
            bx_et: "test".to_string(),
            bx_umidtoken: "test".to_string(),
            csrf_token: "test".to_string(),
            timestamp: chrono::Utc::now().timestamp_millis(),
        };
        assert!(!sig.is_expired());
    }
}
