// Qwen Provider 模块 - 通义千问网站端接入
// 
// 架构设计:
// - 账号存储: 复用现有 Account 结构体，存储在 data_dir/accounts/{id}.json
// - 认证方式: OAuth (与 Gemini/Claude 一致)
// - 管理方式: TokenManager 统一管理
//
// 实现细节:
// - 通过 OAuth 登录获取 Session Cookie
// - Cookie 以 JSON 格式存储在 token.access_token 字段
// - 发送请求时需要额外的动态签名 (bx_et, bx_umidtoken)

pub mod client;
pub mod signer;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Qwen 签名数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QwenSignatures {
    pub bx_et: String,
    pub bx_umidtoken: String,
    pub csrf_token: String,
    pub timestamp: i64,
}

impl QwenSignatures {
    /// 检查签名是否过期 (默认 5 分钟)
    pub fn is_expired(&self) -> bool {
        let now = chrono::Utc::now().timestamp_millis();
        now - self.timestamp > 5 * 60 * 1000
    }
}

/// 模型映射表 (OpenAI 模型名 -> Qwen 模型名)
pub fn get_model_mapping() -> HashMap<String, String> {
    let mut mapping = HashMap::new();
    mapping.insert("qwen-turbo".to_string(), "Qwen3.5-Plus".to_string());
    mapping.insert("qwen-plus".to_string(), "Qwen3.5-Plus".to_string());
    mapping.insert("qwen-max".to_string(), "Qwen3-Max".to_string());
    mapping.insert(
        "qwen-max-thinking".to_string(),
        "Qwen3-Max-Thinking-Preview".to_string(),
    );
    mapping.insert("qwen-coder".to_string(), "Qwen3-Coder".to_string());
    mapping.insert(
        "qwen-coder-fast".to_string(),
        "Qwen3-Coder-Flash".to_string(),
    );
    mapping.insert("qwen-vl".to_string(), "Qwen3-VL-Plus".to_string());
    mapping.insert(
        "qwen-vl-large".to_string(),
        "Qwen3-VL-235B-A22B".to_string(),
    );
    mapping
}

/// 解析 OpenAI 模型名称为 Qwen 模型
/// 
/// 返回: (qwen_model, enable_search, enable_thinking)
pub fn resolve_model(model: &str) -> (String, bool, bool) {
    let mapping = get_model_mapping();
    let mut enable_search = false;
    let mut enable_thinking = false;

    // 检查特殊后缀
    let base_model = if model.ends_with("-search") {
        enable_search = true;
        &model[..model.len() - 7]
    } else if model.ends_with("-thinking") {
        enable_thinking = true;
        &model[..model.len() - 9]
    } else {
        model
    };

    let qwen_model = mapping
        .get(base_model)
        .cloned()
        .unwrap_or_else(|| "Qwen3.5-Plus".to_string());

    (qwen_model, enable_search, enable_thinking)
}