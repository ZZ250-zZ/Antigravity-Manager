// Qwen Handler - 处理通义千问 API 请求
// 架构: 完全契合 Gemini Handler 模式，使用 TokenManager 管理账号
// 认证: OAuth 方式 (Session Cookie 存储在 token.access_token)

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use bytes::BytesMut;
use futures::StreamExt;
use serde_json::{json, Value};
use tracing::{debug, error, info, warn};

use crate::proxy::server::AppState;
use crate::proxy::mappers::qwen::{unwrap_response, wrap_request};
use crate::proxy::providers::qwen::{
    client::QwenClient,
    resolve_model,
};

const MAX_RETRY_ATTEMPTS: usize = 3;

/// 处理 Qwen 聊天请求
/// 路径: POST /v1/qwen/chat/completions
pub async fn handle_chat(
    State(state): State<AppState>,
    _headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let trace_id = format!("qwen_{}", chrono::Utc::now().timestamp_millis());
    info!("[{}] Received Qwen chat request", trace_id);
    
    // 获取 debug 日志配置
    let debug_cfg = state.debug_logging.read().await.clone();

    // 1. 提取模型名称
    let model_name = body
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("qwen-plus");

    let (qwen_model, enable_search, enable_thinking) = resolve_model(model_name);
    debug!(
        "[{}] Model mapping: {} -> {} (search: {}, thinking: {})",
        trace_id, model_name, qwen_model, enable_search, enable_thinking
    );

    // 2. 判断客户端是否需要流式响应
    let client_wants_stream = body.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);
    let is_stream = client_wants_stream;

    // 3. 从 TokenManager 获取账号
    // 复用 Gemini 相同的账号轮转逻辑
    let pool_size = state.token_manager.len();
    if pool_size == 0 {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "No Qwen accounts available".to_string(),
        ));
    }

    // 4. 包装请求
    let wrapped_body = wrap_request(&body, &qwen_model, enable_search, enable_thinking);
    debug!("[{}] Wrapped request: {}", trace_id, wrapped_body.to_string());

    // 4. 尝试多个账号 (完全复用 Gemini 的 TokenManager 逻辑)
    let mut last_error = String::new();
    
    for attempt in 0..MAX_RETRY_ATTEMPTS.min(pool_size).max(1) {
        // 获取 Token (复用 Gemini 相同的 token_manager.get_token 逻辑)
        // Qwen 通过 OAuth 登录获取 Session Cookie，存储在 access_token 字段
        let (access_token, _project_id, email, account_id, _wait_ms) = match state
            .token_manager
            .get_token("qwen", attempt > 0, Some("qwen-session"), &qwen_model)
            .await
        {
            Ok(t) => t,
            Err(e) => {
                warn!("[{}] Failed to get token: {}", trace_id, e);
                last_error = e;
                continue;
            }
        };

        info!(
            "[{}] Attempt {}/{} using account {}",
            trace_id,
            attempt + 1,
            MAX_RETRY_ATTEMPTS,
            email
        );

        // 获取签名 (access_token 中存储的是 Cookie JSON)
        let signatures = match state.qwen_signer.get_signatures(&account_id, &access_token).await {
            Ok(sig) => sig,
            Err(e) => {
                warn!("[{}] Failed to get signatures: {}", trace_id, e);
                last_error = format!("Signature error: {}", e);
                continue;
            }
        };

        // 发送请求
        let client = QwenClient::new();
        match client.chat_stream(&access_token, &wrapped_body, &signatures).await {
            Ok(response_stream) => {
                info!("[{}] Successfully connected to Qwen API", trace_id);
                
                // 使用 debug_logger 包装流（与 Gemini 一致）
                let meta = json!({
                    "protocol": "qwen",
                    "trace_id": trace_id,
                    "original_model": model_name,
                    "mapped_model": qwen_model,
                    "attempt": attempt,
                });
                let mut response_stream = crate::proxy::debug_logger::wrap_stream_with_debug(
                    Box::pin(response_stream),
                    debug_cfg.clone(),
                    trace_id.clone(),
                    "upstream_response",
                    meta,
                );
                
                if is_stream {
                    // 流式响应
                    // [FIX] 首块数据 30 秒超时检查（与 Gemini #859 一致）
                    let mut first_chunk = None;
                    let mut retry_qwen = false;

                    match tokio::time::timeout(
                        std::time::Duration::from_secs(30),
                        response_stream.next(),
                    )
                    .await
                    {
                        Ok(Some(Ok(bytes))) => {
                            if bytes.is_empty() {
                                tracing::warn!("[Qwen] Empty first chunk received, retrying...");
                                retry_qwen = true;
                            } else {
                                first_chunk = Some(bytes);
                            }
                        }
                        Ok(Some(Err(e))) => {
                            tracing::warn!("[Qwen] Stream error during peek: {}, retrying...", e);
                            last_error = format!("Stream error: {}", e);
                            retry_qwen = true;
                        }
                        Ok(None) => {
                            tracing::warn!("[Qwen] Stream ended immediately, retrying...");
                            last_error = "Empty response".to_string();
                            retry_qwen = true;
                        }
                        Err(_) => {
                            tracing::warn!("[Qwen] Timeout waiting for first chunk, retrying...");
                            last_error = "Timeout".to_string();
                            retry_qwen = true;
                        }
                    }

                    if retry_qwen {
                        continue;
                    }
                    
                    // 处理流式响应，传入 first_chunk
                    let stream = handle_stream(response_stream, first_chunk, trace_id.clone(), model_name.to_string());
                    return Ok(stream_response(stream, &email, model_name));
                } else {
                    // 非流式响应：收集流到 JSON
                    use crate::proxy::mappers::qwen::collector::collect_stream_to_json;
                    match collect_stream_to_json(Box::pin(response_stream), &trace_id).await {
                        Ok(openai_resp) => {
                            info!("[{}] Stream collected and converted to JSON", trace_id);
                            // collector 已经返回 OpenAI 格式，直接使用
                            return Ok((
                                StatusCode::OK,
                                [
                                    ("X-Account-Email", email.as_str()),
                                    ("X-Mapped-Model", &model_name),
                                ],
                                Json(openai_resp),
                            )
                                .into_response());
                        }
                        Err(e) => {
                            error!("[{}] Stream collection error: {}", trace_id, e);
                            return Ok((
                                StatusCode::INTERNAL_SERVER_ERROR,
                                format!("Stream collection error: {}", e),
                            )
                                .into_response());
                        }
                    }
                }
            }
            Err(e) => {
                warn!("[{}] Request failed: {}", trace_id, e);
                last_error = e.to_string();
                
                // 如果是认证错误，标记账号限流 (复用 Gemini 相同的限流机制)
                if e.to_string().contains("401") || e.to_string().contains("403") {
                    state.token_manager.mark_rate_limited(
                        &email,
                        401,
                        None,
                        "Authentication failed",
                    ).await;
                }
                
                continue;
            }
        }
    }

    // 所有尝试都失败
    Err((
        StatusCode::BAD_GATEWAY,
        format!("All Qwen accounts failed. Last error: {}", last_error),
    ))
}

/// 处理 SSE 流
/// 
/// 参数:
/// - stream: 上游响应流
/// - first_chunk: 首块数据（已在超时检查中获取）
/// - trace_id: 追踪 ID
/// - model_name: 模型名称
fn handle_stream(
    stream: impl futures::Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send + 'static,
    first_chunk: Option<bytes::Bytes>,
    trace_id: String,
    model_name: String,
) -> impl futures::Stream<Item = Result<axum::body::Bytes, String>> {
    async_stream::stream! {
        let mut stream = Box::pin(stream);
        let mut buffer = BytesMut::new();
        
        // 处理首块数据
        let mut first_data = first_chunk;

        loop {
            // [FIX] 60秒心跳保活: 延长超时时间以增加网络抖动容错（与 Gemini 一致）
            let item = if let Some(fd) = first_data.take() {
                Some(Ok(fd))
            } else {
                match tokio::time::timeout(
                    std::time::Duration::from_secs(60),
                    stream.next()
                ).await {
                    Ok(item) => item,
                    Err(_) => {
                        // 超时，发送心跳包 (SSE Comment 格式)
                        yield Ok(axum::body::Bytes::from(": ping\n\n"));
                        continue;
                    }
                }
            };
            
            match item {
                Some(Ok(bytes)) => {
                    buffer.extend_from_slice(&bytes);

                    // 处理 SSE 行
                    while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
                        let line = buffer.split_to(pos + 1);
                        let line_str = String::from_utf8_lossy(&line);
                        let line_trimmed = line_str.trim();

                        if line_trimmed.is_empty() {
                            continue;
                        }

                        if line_trimmed.starts_with("data: ") {
                            let data = &line_trimmed[6..];
                            
                            if data == "[DONE]" {
                                yield Ok(axum::body::Bytes::from("data: [DONE]\n\n"));
                                continue;
                            }

                            // 解析并转换
                            match serde_json::from_str::<Value>(data) {
                                Ok(mut json) => {
                                    unwrap_response(&mut json, &model_name);
                                    let output = format!("data: {}\n\n", json.to_string());
                                    yield Ok(axum::body::Bytes::from(output));
                                }
                                Err(e) => {
                                    debug!("[{}] JSON parse error: {}", trace_id, e);
                                    // 透传原始数据
                                    yield Ok(axum::body::Bytes::from(format!("{}\n\n", line_trimmed)));
                                }
                            }
                        }
                    }
                }
                Some(Err(e)) => {
                    error!("[{}] Stream error: {}", trace_id, e);
                    yield Err(format!("Stream error: {}", e));
                    break;
                }
                None => break, // 流正常结束
            }
        }
        
        // [FIX #1732] 强制刷新剩余缓冲区（与 Gemini 一致）
        // 防止最后一块 SSE 数据不以换行符结尾导致的挂起
        if !buffer.is_empty() {
            if let Ok(line_str) = std::str::from_utf8(&buffer) {
                let line = line_str.trim();
                if !line.is_empty() {
                    tracing::debug!("[{}] SSE Termination: Flushing remaining {} bytes in buffer", trace_id, buffer.len());
                    if line.starts_with("data: ") {
                        let data = &line[6..];
                        if let Ok(mut json) = serde_json::from_str::<Value>(data) {
                            unwrap_response(&mut json, &model_name);
                            let output = format!("data: {}\n\n", json.to_string());
                            yield Ok(axum::body::Bytes::from(output));
                        }
                    }
                }
            }
            buffer.clear();
        }
    }
}

/// 构建流式响应
fn stream_response(
    stream: impl futures::Stream<Item = Result<axum::body::Bytes, String>> + Send + 'static,
    account_id: &str,
    model_name: &str,
) -> axum::response::Response {
    use axum::body::Body;
    use axum::response::Response;

    let body = Body::from_stream(stream);
    
    Response::builder()
        .header("Content-Type", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .header("Connection", "keep-alive")
        .header("X-Accel-Buffering", "no")
        .header("X-Account-Id", account_id)
        .header("X-Mapped-Model", model_name)
        .body(body)
        .unwrap()
        .into_response()
}

/// 获取模型列表
pub async fn handle_models(
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    // 检查是否有可用的账号 (复用 token_manager.len())
    if state.token_manager.len() == 0 {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "No accounts available".to_string(),
        ));
    }

    let models = json!({
        "object": "list",
        "data": [
            {
                "id": "qwen-turbo",
                "object": "model",
                "created": 1677649963,
                "owned_by": "qwen",
            },
            {
                "id": "qwen-plus",
                "object": "model",
                "created": 1677649963,
                "owned_by": "qwen",
            },
            {
                "id": "qwen-max",
                "object": "model",
                "created": 1677649963,
                "owned_by": "qwen",
            },
            {
                "id": "qwen-max-thinking",
                "object": "model",
                "created": 1677649963,
                "owned_by": "qwen",
            },
            {
                "id": "qwen-max-search",
                "object": "model",
                "created": 1677649963,
                "owned_by": "qwen",
            },
            {
                "id": "qwen-coder",
                "object": "model",
                "created": 1677649963,
                "owned_by": "qwen",
            },
            {
                "id": "qwen-vl",
                "object": "model",
                "created": 1677649963,
                "owned_by": "qwen",
            },
        ]
    });

    Ok(Json(models))
}

/// 健康检查
pub async fn handle_health(
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let has_accounts = state.token_manager.len() > 0;
    
    Ok(Json(json!({
        "status": if has_accounts { "ok" } else { "no_accounts" },
        "provider": "qwen",
        "timestamp": chrono::Utc::now().timestamp(),
    })))
}
