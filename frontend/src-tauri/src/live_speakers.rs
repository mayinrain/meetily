//! A bounded tee of the original mixed PCM to one recording-scoped speaker worker.
use std::{path::Path, sync::{Arc, Mutex}, time::Duration};
use serde_json::{json, Value};
use tokio::{sync::mpsc, task::JoinHandle};
use tauri::Manager;

const SERVICE: &str = "http://127.0.0.1:8765";
const RATE: usize = 48000;
static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static LAST: Mutex<Option<Value>> = Mutex::new(None);

enum Input { Audio(u64, Vec<f32>), Finish, Cancel }
struct Session {
    sender: mpsc::Sender<Input>,
    task: JoinHandle<Value>,
    pending: Vec<f32>,
    frames: u64,
    job_id: String,
    segments: Arc<Mutex<Vec<Value>>>,
    snapshot: Arc<Mutex<Value>>,
    failure: Arc<Mutex<Option<String>>>,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3)).timeout(Duration::from_secs(15))
        .build().map_err(|e| e.to_string())
}
async fn response(request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request.send().await.map_err(|e| e.to_string())?;
    let code = response.status();
    let body: Value = response.json().await.map_err(|e| e.to_string())?;
    if !code.is_success() { return Err(body["detail"].as_str().unwrap_or("Speaker service failed").into()); }
    Ok(body)
}

async fn start<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    if SESSION.lock().unwrap().is_some() { return Err("Previous speaker stream is still active".into()); }
    *LAST.lock().unwrap() = None;
    let client = client()?;
    let health = response(client.get(format!("{SERVICE}/health"))).await?;
    // Only the prepared SenseVoice path owns an ASR model in this service.
    if health["status"] != "ready" || health["speaker_stream_available"] != true { return Ok(()); }
    if health["speaker_model"] == "pyannote-community-1" && health["speaker_batch_publication"] != true {
        return Err("Update the offline speech service with this build: live speaker batches are unavailable".into());
    }
    let job = response(client.post(format!("{SERVICE}/v1/speaker-streams")).json(&json!({"sample_rate": RATE}))).await?;
    let job_id = job["job_id"].as_str().ok_or("Missing live speaker job ID")?.to_string();
    if let Err(error) = crate::summary::live::begin(app, &job_id).await {
        log::warn!("Could not prepare incremental summaries: {error}");
    }
    let (sender, mut receiver) = mpsc::channel::<Input>(8);
    let segments = Arc::new(Mutex::new(Vec::<Value>::new()));
    let snapshot = Arc::new(Mutex::new(job));
    let failure = Arc::new(Mutex::new(None::<String>));
    let (worker_segments, worker_snapshot, worker_failure) = (segments.clone(), snapshot.clone(), failure.clone());
    let base = format!("{SERVICE}/v1/speaker-streams/{job_id}");
    let summary_job_id = job_id.clone();
    let task = tokio::spawn(async move {
        let work: Result<Value, String> = async {
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut sent_segments = 0;
            loop {
                let error = worker_failure.lock().unwrap().clone();
                if let Some(error) = error { return Err(error); }
                let input = tokio::select! {
                    input = receiver.recv() => input,
                    _ = interval.tick() => {
                        let rows = worker_segments.lock().unwrap().clone();
                        if rows.len() != sent_segments {
                            response(client.post(format!("{base}/segments")).json(&json!({"segments": rows}))).await?;
                            sent_segments = rows.len();
                        }
                        let mut state = response(client.get(&base)).await?;
                        state["transcript_segments"] = json!(rows);
                        crate::summary::live::offer(&summary_job_id, &state);
                        let running = state["status"] == "running";
                        *worker_snapshot.lock().unwrap() = state.clone();
                        if !running { return Err(state["error"].as_str().unwrap_or("Speaker worker stopped").into()); }
                        continue;
                    }
                };
                match input {
                    Some(Input::Audio(offset, pcm)) => {
                        let count = pcm.len() as u64;
                        let bytes: Vec<u8> = pcm.iter().flat_map(|sample| sample.to_le_bytes()).collect();
                        let ack = response(client.post(format!("{base}/audio?offset={offset}")).body(bytes)).await?;
                        if ack["received_frames"].as_u64() != Some(offset+count) { return Err("Speaker audio offset mismatch".into()); }
                    }
                    Some(Input::Finish) => {
                        let rows = worker_segments.lock().unwrap().clone();
                        response(client.post(format!("{base}/segments")).json(&json!({"segments": rows}))).await?;
                        response(client.post(format!("{base}/finish"))).await?;
                        let deadline = tokio::time::Instant::now()+Duration::from_secs(110);
                        loop {
                            let mut state = response(client.get(&base)).await?;
                            state["transcript_segments"] = json!(rows);
                            crate::summary::live::offer(&summary_job_id, &state);
                            if state["status"] == "completed" { return Ok(state); }
                            if state["status"] != "running" { return Err(state["error"].as_str().unwrap_or("Speaker finalization failed").into()); }
                            if tokio::time::Instant::now() > deadline { return Err("Speaker finalization timed out".into()); }
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                    }
                    Some(Input::Cancel) | None => return Err("Recording speaker stream cancelled".into()),
                }
            }
        }.await;
        let result = match work {
            Ok(value) => value,
            Err(error) => {
                let _ = response(client.post(format!("{base}/cancel"))).await;
                let mut value = worker_snapshot.lock().unwrap().clone();
                value["status"] = json!("failed");
                value["error"] = json!(error);
                log::warn!("Live speakers failed: {}", error);
                value
            }
        };
        *worker_snapshot.lock().unwrap() = result.clone();
        crate::summary::live::offer(&summary_job_id, &result);
        result
    });
    log::info!("Live speaker stream started: job={job_id} rate={RATE}");
    *SESSION.lock().unwrap() = Some(Session { sender, task, pending: Vec::with_capacity(RATE), frames: 0,
                                            job_id, segments, snapshot, failure });
    Ok(())
}

pub async fn begin<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    *LAST.lock().unwrap() = None;
    let config = crate::api::api::api_get_transcript_config(app.clone(), app.state(), None).await;
    if !matches!(config, Ok(Some(config)) if config.provider == "sensevoice") { return; }
    if let Err(error) = start(app).await {
        log::warn!("Recording continues without live speakers: {error}");
        *LAST.lock().unwrap() = Some(json!({"job_id":uuid::Uuid::new_v4().simple().to_string(),
            "status":"failed", "mode":"recording-live", "error":error}));
    }
}

pub fn push_audio(samples: &[f32], sample_rate: u32) {
    let mut current = SESSION.lock().unwrap();
    let Some(session) = current.as_mut() else { return };
    if session.failure.lock().unwrap().is_some() { return; }
    if sample_rate as usize != RATE {
        *session.failure.lock().unwrap() = Some("Unexpected mixed audio sample rate".into());
        return;
    }
    session.pending.extend_from_slice(samples);
    while session.pending.len() >= RATE {
        let pcm = session.pending.drain(..RATE).collect();
        if session.sender.try_send(Input::Audio(session.frames, pcm)).is_err() {
            *session.failure.lock().unwrap() = Some("Speaker inference cannot keep up; saved audio and ASR continue".into());
            session.pending.clear();
            return;
        }
        session.frames += RATE as u64;
    }
}

pub fn segment(update: &crate::audio::transcription::TranscriptUpdate) {
    if update.is_partial { return; }
    if let Some(session) = SESSION.lock().unwrap().as_ref() {
        session.segments.lock().unwrap().push(json!({"id":format!("seg_{}",update.sequence_id), "text":update.text,
            "audio_start_time":update.audio_start_time, "audio_end_time":update.audio_end_time}));
    }
}

async fn close(cancel: bool) -> Option<Value> {
    let session = SESSION.lock().unwrap().take();
    let Some(mut session) = session else { return LAST.lock().unwrap().clone() };
    let mut snapshot = session.snapshot.lock().unwrap().clone();
    snapshot["transcript_segments"] = json!(session.segments.lock().unwrap().clone());
    crate::summary::live::offer(&session.job_id, &snapshot);
    crate::summary::live::recording_stopped(&session.job_id);
    *LAST.lock().unwrap() = Some(session.snapshot.lock().unwrap().clone());
    let result = match tokio::time::timeout(Duration::from_secs(115), async {
        if !cancel && !session.pending.is_empty() {
            let _ = session.sender.send(Input::Audio(session.frames, std::mem::take(&mut session.pending))).await;
        }
        let _ = session.sender.send(if cancel { Input::Cancel } else { Input::Finish }).await;
        (&mut session.task).await
    }).await {
        Ok(Ok(value)) => value,
        other => {
            session.task.abort();
            if let Ok(client) = client() {
                let _ = response(client.post(format!("{SERVICE}/v1/speaker-streams/{}/cancel", session.job_id))).await;
            }
            json!({"job_id":session.job_id,"mode":"recording-live","status":"failed","error":format!("Speaker task did not finish: {other:?}")})
        }
    };
    crate::summary::live::offer(&session.job_id, &result);
    *LAST.lock().unwrap() = Some(result.clone());
    Some(result)
}
pub async fn finish() -> Option<Value> { close(false).await }
pub async fn cancel() {
    if let Some(session) = SESSION.lock().unwrap().as_ref() { crate::summary::live::cancel(&session.job_id); }
    let _ = close(true).await;
}

pub fn save_recording_result(folder: &Path, result: &Value) -> Result<(), String> {
    if let Some(job_id) = result["job_id"].as_str() {
        if let Err(error) = crate::summary::live::attach_folder(job_id, folder) {
            log::warn!("Could not attach incremental summaries to recording: {error}");
        }
    }
    let mut file = tempfile::NamedTempFile::new_in(folder).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut file, result).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(folder.join("speakers-live.json")).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_recording_speakers() -> Option<Value> {
    let mut value = match SESSION.lock().unwrap().as_ref() {
        Some(session) => Some(session.snapshot.lock().unwrap().clone()),
        None => LAST.lock().unwrap().clone(),
    };
    if let Some(value) = value.as_mut() {
        if let Some(status) = value["job_id"].as_str().and_then(crate::summary::live::status) {
            value["summary"] = status;
        }
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn full_speaker_queue_fails_without_blocking_or_growing_audio_memory() {
        let (sender, mut receiver) = mpsc::channel(1);
        let failure = Arc::new(Mutex::new(None));
        let task = tokio::spawn(std::future::pending::<Value>());
        *SESSION.lock().unwrap() = Some(Session { sender, task, pending: Vec::new(), frames: 0,
            job_id: "test".into(), segments: Arc::new(Mutex::new(Vec::new())),
            snapshot: Arc::new(Mutex::new(json!({}))), failure: failure.clone() });
        push_audio(&vec![0.0; RATE], RATE as u32);
        push_audio(&vec![0.0; RATE], RATE as u32);
        push_audio(&vec![0.0; RATE], RATE as u32);
        assert!(failure.lock().unwrap().is_some());
        let session = SESSION.lock().unwrap().take().unwrap();
        assert_eq!(session.frames, RATE as u64);
        assert!(session.pending.is_empty());
        match receiver.try_recv().unwrap() {
            Input::Audio(0, pcm) => assert_eq!(pcm.len(), RATE),
            _ => panic!("Original first audio block was not preserved"),
        }
        assert!(receiver.try_recv().is_err());
        session.task.abort();
    }
}
