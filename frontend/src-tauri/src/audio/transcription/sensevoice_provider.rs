use super::provider::{TranscriptResult, TranscriptionError, TranscriptionProvider};
use async_trait::async_trait;
use serde::Deserialize;
use std::time::Duration;

const SERVICE_URL: &str = "http://127.0.0.1:8765";

pub struct SenseVoiceProvider {
    client: reqwest::Client,
    run_id: String,
    service_url: String,
}

#[derive(Deserialize)]
struct SegmentResponse {
    text: String,
    run_id: String,
}

impl SenseVoiceProvider {
    pub fn new() -> Result<Self, String> {
        Self::with_url(SERVICE_URL.to_string())
    }

    fn with_url(service_url: String) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self { client, run_id: uuid::Uuid::new_v4().to_string(), service_url })
    }

    async fn status(&self) -> Result<serde_json::Value, String> {
        let response = self.client.get(format!("{}/health", self.service_url))
            .timeout(Duration::from_secs(3)).send().await
            .map_err(|e| format!("SenseVoice service is unavailable at {}: {e}", self.service_url))?
            .error_for_status().map_err(|e| e.to_string())?;
        response.json().await.map_err(|e| e.to_string())
    }

    pub async fn validate(&self) -> Result<(), String> {
        let status = self.status().await?;
        if status["status"] != "ready" || status["busy"] != false {
            return Err("SenseVoice service is not ready or another transcription is active".into());
        }
        Ok(())
    }

    async fn available(&self) -> Result<bool, String> {
        let status = self.status().await?;
        Ok(status["busy"] == false && (status["status"] == "ready" || status["status"] == "not_ready"))
    }

    async fn set_model_loaded(&self, loaded: bool) -> Result<(), String> {
        let action = if loaded { "load" } else { "unload" };
        let response = self.client.post(format!("{}/v1/models/{action}", self.service_url))
            .timeout(Duration::from_secs(30)).send().await
            .map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?;
        let result: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
        let expected = if loaded { "ready" } else { "unloaded" };
        if result["status"] != expected {
            return Err(format!("SenseVoice did not confirm model {action}"));
        }
        Ok(())
    }

    pub async fn prepare(&self) -> Result<(), String> {
        self.set_model_loaded(true).await?;
        self.validate().await
    }

    pub async fn unload(&self) -> Result<(), String> {
        self.set_model_loaded(false).await
    }

    pub async fn require_idle_and_unloaded(&self) -> Result<(), String> {
        let status = self.status().await?;
        if status["status"] != "not_ready" || status["busy"] != false {
            return Err("请先完成转写或说话人处理并释放模型，再生成本地纪要".into());
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn sensevoice_status() -> Result<bool, String> {
    // A reachable, unloaded model remains selectable without allocating it.
    if !SenseVoiceProvider::new()?.available().await? {
        return Err("SenseVoice service is not ready or another transcription is active".into());
    }
    Ok(true)
}

pub async fn unload_after_transcription() {
    let result = match SenseVoiceProvider::new() {
        Ok(provider) => provider.unload().await,
        Err(error) => Err(error),
    };
    match result {
        Ok(()) => log::info!("SenseVoice model unloaded after transcription completed"),
        Err(error) => log::warn!("Failed to unload SenseVoice model: {}", error),
    }
}

#[async_trait]
impl TranscriptionProvider for SenseVoiceProvider {
    async fn transcribe(&self, audio: Vec<f32>, _language: Option<String>) -> Result<TranscriptResult, TranscriptionError> {
        let body: Vec<u8> = audio.iter().flat_map(|sample| sample.to_le_bytes()).collect();
        let response = self.client.post(format!("{}/v1/segment", self.service_url))
            .header("Content-Type", "application/octet-stream")
            .header("X-Run-Id", &self.run_id).body(body).send().await
            .map_err(|e| TranscriptionError::EngineFailed(e.to_string()))?;
        if !response.status().is_success() {
            let status = response.status();
            let detail = response.text().await.unwrap_or_default();
            return Err(TranscriptionError::EngineFailed(format!("SenseVoice {status}: {detail}")));
        }
        let result: SegmentResponse = response.json().await
            .map_err(|e| TranscriptionError::EngineFailed(e.to_string()))?;
        log::info!("SenseVoice parent_run={} service_run={}", self.run_id, result.run_id);
        Ok(TranscriptResult { text: result.text, confidence: None, is_partial: false })
    }

    async fn is_model_loaded(&self) -> bool { self.validate().await.is_ok() }
    async fn get_current_model(&self) -> Option<String> { Some("sensevoice-small-int8".into()) }
    fn provider_name(&self) -> &'static str { "SenseVoice" }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn summary_requires_both_idle_service_and_unloaded_asr() {
        let (provider, task) = server(vec![
            ("GET /health ", 200, r#"{"status":"ready","busy":false}"#),
            ("GET /health ", 200, r#"{"status":"not_ready","busy":true}"#),
            ("GET /health ", 200, r#"{"status":"not_ready","busy":false}"#),
        ]).await;
        assert!(provider.require_idle_and_unloaded().await.is_err());
        assert!(provider.require_idle_and_unloaded().await.is_err());
        provider.require_idle_and_unloaded().await.unwrap();
        task.await.unwrap();
    }

    async fn server(replies: Vec<(&'static str, u16, &'static str)>) -> (SenseVoiceProvider, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            for (expected, code, body) in replies {
                let (mut stream, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept())
                    .await.unwrap().unwrap();
                let mut request = Vec::new();
                loop {
                    let mut buffer = [0; 1024];
                    let read = tokio::time::timeout(Duration::from_secs(3), stream.read(&mut buffer))
                        .await.unwrap().unwrap();
                    assert!(read > 0);
                    request.extend_from_slice(&buffer[..read]);
                    if request.windows(4).any(|w| w == b"\r\n\r\n") { break; }
                }
                assert!(String::from_utf8_lossy(&request).starts_with(expected));
                let reply = format!("HTTP/1.1 {code} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                stream.write_all(reply.as_bytes()).await.unwrap();
            }
        });
        (SenseVoiceProvider::with_url(url).unwrap(), task)
    }

    #[tokio::test]
    async fn unloaded_service_is_selectable_without_loading_the_model() {
        let (provider, task) = server(vec![("GET /health ", 200, r#"{"status":"not_ready","busy":false}"#)]).await;
        assert!(provider.available().await.unwrap());
        task.await.unwrap();
    }

    #[tokio::test]
    async fn recording_preparation_loads_then_checks_readiness() {
        let (provider, task) = server(vec![
            ("POST /v1/models/load ", 200, r#"{"status":"ready"}"#),
            ("GET /health ", 200, r#"{"status":"ready","busy":false}"#),
        ]).await;
        provider.prepare().await.unwrap();
        task.await.unwrap();
    }

    #[tokio::test]
    async fn busy_service_cannot_be_prepared_or_unloaded() {
        let (provider, task) = server(vec![
            ("POST /v1/models/load ", 409, r#"{"detail":"Transcription is active"}"#),
            ("POST /v1/models/unload ", 409, r#"{"detail":"Transcription is active"}"#),
        ]).await;
        assert!(provider.prepare().await.is_err());
        assert!(provider.unload().await.is_err());
        task.await.unwrap();
    }

    #[tokio::test]
    async fn unload_requires_the_service_to_confirm_release() {
        let (provider, task) = server(vec![
            ("POST /v1/models/unload ", 200, r#"{"status":"ready"}"#),
            ("POST /v1/models/unload ", 200, r#"{"status":"unloaded"}"#),
        ]).await;
        assert!(provider.unload().await.is_err());
        provider.unload().await.unwrap();
        task.await.unwrap();
    }
}
