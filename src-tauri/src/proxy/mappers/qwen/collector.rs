// Qwen 流式响应收集器
// 将 SSE 流收集为完整的 JSON 响应

use bytes::Bytes;
use futures::{Stream, StreamExt};
use serde_json::Value;

/// 收集流式响应为完整的 JSON
pub async fn collect_stream_to_json<S, E>(
    mut stream: S,
    _session_id: &str,
) -> Result<Value, String>
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
    E: std::fmt::Display,
{
    let mut full_content = String::new();
    let mut model_name = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream error: {}", e))?;
        let text = String::from_utf8_lossy(&chunk);
        
        for line in text.lines() {
            let line = line.trim();
            if !line.starts_with("data: ") {
                continue;
            }

            let data = &line[6..];
            if data == "[DONE]" {
                break;
            }

            if let Ok(json) = serde_json::from_str::<Value>(data) {
                // 提取内容
                if let Some(content) = json
                    .get("choices")
                    .and_then(|c| c.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|choice| choice.get("delta"))
                    .and_then(|delta| delta.get("content"))
                    .and_then(|c| c.as_str())
                {
                    full_content.push_str(content);
                }

                // 提取模型名
                if model_name.is_empty() {
                    if let Some(model) = json.get("model").and_then(|m| m.as_str()) {
                        model_name = model.to_string();
                    }
                }
            }
        }
    }

    // 构建完整响应
    let response = serde_json::json!({
        "id": format!("chatcmpl-{}", uuid::Uuid::new_v4().to_string().replace("-", "")),
        "object": "chat.completion",
        "created": chrono::Utc::now().timestamp(),
        "model": if model_name.is_empty() { "qwen-max" } else { &model_name },
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": full_content,
            },
            "finish_reason": "stop",
        }],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
    });

    Ok(response)
}


