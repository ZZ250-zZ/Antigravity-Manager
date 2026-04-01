/// CN Provider Handler — 将 OpenAI 格式请求透传到本地 Node.js sidecar，
/// sidecar 负责协议转换（OpenAI ↔ 各厂商 Web API）。
///
/// 路由判定：若 model 名匹配已知 CN provider 前缀且 cn_provider.enabled，
/// 则整个请求/响应直接反向代理到 sidecar，不经过 Google v1internal 路径。

use axum::{
    body::Body,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use futures::StreamExt;
use serde_json::Value;
use tokio::time::Duration;

use crate::proxy::config::CnProviderConfig;
use crate::proxy::server::AppState;

/// 已知的 CN provider model 前缀/完整名称（小写匹配）。
/// 命中即路由到 sidecar。
const CN_MODEL_PREFIXES: &[&str] = &[
    "qwen",
    "kimi",
    "moonshot",
    "glm-4",
    "chatglm",
    "zhipu",
    "doubao",
    "deepseek",
    "hailuo",
    "minimax",
    "step",
    "stepchat",
    "spark",
    "metaso",
    "yuanbao",
    "momi",
    "mimo",
];

/// 判断 model 名称是否属于 CN provider
pub fn is_cn_provider_model(model: &str) -> bool {
    let m = model.to_lowercase();
    CN_MODEL_PREFIXES
        .iter()
        .any(|prefix| m.starts_with(prefix))
}

/// 反向代理到 CN Provider sidecar，请求/响应均为 OpenAI 格式，原样透传。
pub async fn forward_to_cn_provider(
    state: &AppState,
    body: Value,
    incoming_headers: &HeaderMap,
) -> Response {
    let cn_cfg = state.cn_provider.read().await.clone();
    if !cn_cfg.enabled {
        return (StatusCode::BAD_REQUEST, "CN Provider is disabled").into_response();
    }

    let url = format!(
        "{}/v1/chat/completions",
        cn_cfg.base_url.trim_end_matches('/')
    );

    let timeout_secs = state.request_timeout.max(5);
    let client = match build_cn_client(timeout_secs) {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };

    // 构建请求头：保留必要的客户端头信息
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    // 透传 Authorization 给 sidecar（sidecar 可按需校验）
    if let Some(auth) = incoming_headers.get(header::AUTHORIZATION) {
        headers.insert(header::AUTHORIZATION, auth.clone());
    }
    if let Some(accept) = incoming_headers.get(header::ACCEPT) {
        headers.insert(header::ACCEPT, accept.clone());
    }

    let body_bytes = serde_json::to_vec(&body).unwrap_or_default();
    tracing::info!(
        "[CN-Provider] Forwarding to sidecar: {} (body: {} bytes)",
        url,
        body_bytes.len()
    );

    let resp = match client
        .post(&url)
        .headers(headers)
        .body(body_bytes)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[CN-Provider] Sidecar request failed: {}", e);
            return (
                StatusCode::BAD_GATEWAY,
                format!("CN Provider sidecar unreachable: {}", e),
            )
                .into_response();
        }
    };

    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);

    let mut out = Response::builder().status(status);
    // 透传 Content-Type（SSE 时为 text/event-stream）
    if let Some(ct) = resp.headers().get(header::CONTENT_TYPE) {
        out = out.header(header::CONTENT_TYPE, ct.clone());
    }

    // 流式透传响应体
    let stream = resp.bytes_stream().map(|chunk| match chunk {
        Ok(b) => Ok::<Bytes, std::io::Error>(b),
        Err(e) => {
            tracing::error!("[CN-Provider] Stream error: {}", e);
            Ok(Bytes::from(format!("Stream error: {}", e)))
        }
    });

    out.body(Body::from_stream(stream)).unwrap_or_else(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, "Failed to build response").into_response()
    })
}

/// 构建到 sidecar 的 HTTP 客户端（本地请求，无需 TLS 指纹）
fn build_cn_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .tcp_nodelay(true)
        .build()
        .map_err(|e| format!("Failed to build CN Provider client: {}", e))
}

/// 从 sidecar 获取可用模型列表（合并到 /v1/models 响应中）
pub async fn fetch_cn_models(cn_cfg: &CnProviderConfig) -> Vec<Value> {
    if !cn_cfg.enabled {
        return vec![];
    }

    let url = format!(
        "{}/v1/models",
        cn_cfg.base_url.trim_end_matches('/')
    );

    let client = match build_cn_client(10) {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(body) = resp.json::<Value>().await {
                body.get("data")
                    .and_then(|d| d.as_array())
                    .cloned()
                    .unwrap_or_default()
            } else {
                vec![]
            }
        }
        _ => vec![],
    }
}
