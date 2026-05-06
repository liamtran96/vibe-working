use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::ipc::Channel;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    pub base_url: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    pub temperature: f32,
    pub max_tokens: u32,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            base_url: "http://127.0.0.1:11434".to_string(),
            model: "gemma3:4b".to_string(),
            api_key: None,
            temperature: 0.7,
            max_tokens: 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ChatOpts {
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub system: Option<String>,
}

/// Event variants pushed to the frontend over a channel during a chat
/// completion. The `kind` tag is set automatically via `serde(tag = ...)`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ChatEvent {
    Chunk { delta: String },
    Done { content: String },
    Error { message: String },
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    temperature: f32,
    max_tokens: u32,
    stream: bool,
}

#[derive(Deserialize)]
struct ChatChunk {
    #[serde(default)]
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    #[serde(default)]
    delta: ChatDelta,
}

#[derive(Deserialize, Default)]
struct ChatDelta {
    #[serde(default)]
    content: Option<String>,
}

fn normalize_base(base: &str) -> &str {
    base.trim_end_matches('/')
}

pub async fn chat_completion_impl(
    config: LlmConfig,
    on_event: Channel<ChatEvent>,
    messages: Vec<ChatMessage>,
    opts: Option<ChatOpts>,
) -> Result<String, String> {
    let result = run_stream(&config, &on_event, messages, opts).await;
    match &result {
        Ok(content) => {
            let _ = on_event.send(ChatEvent::Done {
                content: content.clone(),
            });
        }
        Err(message) => {
            let _ = on_event.send(ChatEvent::Error {
                message: message.clone(),
            });
        }
    }
    result
}

async fn run_stream(
    config: &LlmConfig,
    on_event: &Channel<ChatEvent>,
    messages: Vec<ChatMessage>,
    opts: Option<ChatOpts>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;

    let opts = opts.unwrap_or_default();
    let temperature = opts.temperature.unwrap_or(config.temperature);
    let max_tokens = opts.max_tokens.unwrap_or(config.max_tokens);

    let mut full_messages: Vec<ChatMessage> = Vec::with_capacity(messages.len() + 1);
    if let Some(sys) = opts.system.as_ref().filter(|s| !s.trim().is_empty()) {
        full_messages.push(ChatMessage {
            role: "system".to_string(),
            content: sys.clone(),
        });
    }
    full_messages.extend(messages);

    let body = ChatRequest {
        model: &config.model,
        messages: &full_messages,
        temperature,
        max_tokens,
        stream: true,
    };

    let url = format!("{}/v1/chat/completions", normalize_base(&config.base_url));
    let mut req = client.post(&url).json(&body);
    if let Some(key) = config.api_key.as_ref().filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("LLM request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("LLM HTTP {}: {}", status, txt));
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut full = String::new();

    'outer: while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        loop {
            let sep_idx = buffer.find("\n\n").or_else(|| buffer.find("\r\n\r\n"));
            let Some(end) = sep_idx else { break; };
            let sep_len = if buffer[end..].starts_with("\r\n\r\n") { 4 } else { 2 };
            let event = buffer[..end].to_string();
            buffer.drain(..end + sep_len);

            for line in event.lines() {
                let Some(data) = line.strip_prefix("data:") else { continue; };
                let data = data.trim();
                if data.is_empty() {
                    continue;
                }
                if data == "[DONE]" {
                    break 'outer;
                }
                let Ok(parsed) = serde_json::from_str::<ChatChunk>(data) else { continue; };
                if let Some(choice) = parsed.choices.first() {
                    if let Some(content) = &choice.delta.content {
                        if !content.is_empty() {
                            full.push_str(content);
                            let _ = on_event.send(ChatEvent::Chunk {
                                delta: content.clone(),
                            });
                        }
                    }
                }
            }
        }
    }

    Ok(full)
}

pub async fn llm_health_impl(config: LlmConfig) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
    else {
        return false;
    };

    let url = format!("{}/v1/models", normalize_base(&config.base_url));
    let mut req = client.get(&url);
    if let Some(key) = config.api_key.as_ref().filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }
    matches!(req.send().await, Ok(r) if r.status().is_success())
}
