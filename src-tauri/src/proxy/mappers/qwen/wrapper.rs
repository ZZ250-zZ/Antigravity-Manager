// Qwen 请求包装/解包
// 将 OpenAI 格式转换为 Qwen /api/v2/chat 格式

use serde_json::{json, Value};
use uuid::Uuid;

/// 包装 OpenAI 请求为 Qwen 格式
/// 
/// OpenAI 输入:
/// ```json
/// {
///   "model": "qwen-max",
///   "messages": [
///     {"role": "user", "content": "Hello"}
///   ],
///   "stream": true
/// }
/// ```
/// 
/// Qwen 输出:
/// ```json
/// {
///   "model": "Qwen3-Max",
///   "messages": [{"content": "Hello", "mime_type": "text/plain"}],
///   "deep_search": "0",
///   "req_id": "uuid",
///   "session_id": "uuid",
///   ...
/// }
/// ```
pub fn wrap_request(
    body: &Value,
    mapped_model: &str,
    enable_search: bool,
    enable_thinking: bool,
) -> Value {
    let model = if enable_thinking && !mapped_model.contains("Thinking") {
        // 如果需要思考模式但模型不是思考模型，切换到思考模型
        "Qwen3-Max-Thinking-Preview"
    } else {
        mapped_model
    };

    // 转换消息格式
    let messages = convert_messages(body.get("messages"));

    // 生成 ID
    let req_id = Uuid::new_v4().to_string();
    let session_id = body
        .get("session_id")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    // 提取或生成参数
    let timestamp = chrono::Utc::now().timestamp_millis().to_string();

    json!({
        "model": model,
        "messages": messages,
        "deep_search": if enable_search { "1" } else { "0" },
        "req_id": req_id,
        "session_id": session_id,
        "scene": "chat",
        "sub_scene": "chat",
        "temporary": false,
        "from": "default",
        "parent_req_id": "0",
        "scene_param": "first_turn",
        "chat_client": "h5",
        "client_tm": timestamp,
        "protocol_version": "v2",
        "biz_id": "ai_qwen",
    })
}

/// 转换 OpenAI 消息格式为 Qwen 格式
/// 
/// OpenAI: [{"role": "user", "content": "Hello"}]
/// Qwen: [{"content": "Hello", "mime_type": "text/plain"}]
fn convert_messages(messages: Option<&Value>) -> Vec<Value> {
    let mut result = Vec::new();

    if let Some(arr) = messages.and_then(|m| m.as_array()) {
        for msg in arr {
            let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("user");
            let content = msg.get("content").and_then(|c| c.as_str()).unwrap_or("");

            // Qwen 不支持 role 字段，只支持 content 和 mime_type
            // 角色信息通过消息顺序隐式表达
            let qwen_msg = json!({
                "content": content,
                "mime_type": "text/plain",
                "meta_data": {
                    "role": role,
                }
            });

            result.push(qwen_msg);
        }
    }

    // 如果没有消息，添加默认空消息
    if result.is_empty() {
        result.push(json!({
            "content": "",
            "mime_type": "text/plain",
        }));
    }

    result
}

/// 解包 Qwen 响应为 OpenAI 格式
/// 
/// Qwen 输入:
/// ```json
/// {
///   "data": {
///     "messages": [{"content": "Hello!", "mime_type": "text/plain"}]
///   },
///   "success": true
/// }
/// ```
/// 
/// OpenAI 输出:
/// ```json
/// {
///   "id": "chatcmpl-xxx",
///   "object": "chat.completion.chunk",
///   "created": 1234567890,
///   "model": "qwen-max",
///   "choices": [{
///     "index": 0,
///     "delta": {"content": "Hello!"},
///     "finish_reason": null
///   }]
/// }
/// ```
pub fn unwrap_response(response: &mut Value, model_name: &str) {
    // 提取内容
    let content = response
        .get("data")
        .and_then(|d| d.get("messages"))
        .and_then(|m| m.as_array())
        .and_then(|arr| arr.first())
        .and_then(|msg| msg.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");

    // 检查是否完成
    let finish_reason = if response
        .get("data")
        .and_then(|d| d.get("finished"))
        .and_then(|f| f.as_bool())
        .unwrap_or(false)
    {
        Some("stop")
    } else {
        None
    };

    // 转换为 OpenAI 格式
    let openai_format = json!({
        "id": format!("chatcmpl-{}", Uuid::new_v4().to_string().replace("-", "")),
        "object": "chat.completion.chunk",
        "created": chrono::Utc::now().timestamp(),
        "model": model_name,
        "choices": [{
            "index": 0,
            "delta": {
                "content": content,
            },
            "finish_reason": finish_reason,
        }],
    });

    *response = openai_format;
}

/// 将非流式响应收集为 OpenAI 格式
pub fn unwrap_non_streaming_response(qwen_response: &Value, model_name: &str) -> Value {
    // 提取所有消息内容
    let mut full_content = String::new();
    
    if let Some(messages) = qwen_response
        .get("data")
        .and_then(|d| d.get("messages"))
        .and_then(|m| m.as_array())
    {
        for msg in messages {
            if let Some(content) = msg.get("content").and_then(|c| c.as_str()) {
                full_content.push_str(content);
            }
        }
    }

    json!({
        "id": format!("chatcmpl-{}", Uuid::new_v4().to_string().replace("-", "")),
        "object": "chat.completion",
        "created": chrono::Utc::now().timestamp(),
        "model": model_name,
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
    })
}

/// 提取错误信息
pub fn extract_error(response: &Value) -> Option<String> {
    response
        .get("error_message")
        .and_then(|e| e.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            response
                .get("message")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wrap_request() {
        let body = json!({
            "model": "qwen-max",
            "messages": [{"role": "user", "content": "Hello"}],
        });

        let wrapped = wrap_request(&body, "Qwen3-Max", false, false);

        assert_eq!(wrapped.get("model").unwrap().as_str().unwrap(), "Qwen3-Max");
        assert_eq!(wrapped.get("deep_search").unwrap().as_str().unwrap(), "0");
        assert!(wrapped.get("req_id").is_some());
        assert!(wrapped.get("session_id").is_some());
    }

    #[test]
    fn test_wrap_request_with_search() {
        let body = json!({
            "model": "qwen-max-search",
            "messages": [{"role": "user", "content": "Hello"}],
        });

        let wrapped = wrap_request(&body, "Qwen3-Max", true, false);

        assert_eq!(wrapped.get("deep_search").unwrap().as_str().unwrap(), "1");
    }

    #[test]
    fn test_unwrap_response() {
        let mut response = json!({
            "data": {
                "messages": [{"content": "Hello!", "mime_type": "text/plain"}],
                "finished": false,
            },
            "success": true,
        });

        unwrap_response(&mut response, "qwen-max");

        assert_eq!(response.get("object").unwrap().as_str().unwrap(), "chat.completion.chunk");
        assert_eq!(response.get("model").unwrap().as_str().unwrap(), "qwen-max");
    }
}
