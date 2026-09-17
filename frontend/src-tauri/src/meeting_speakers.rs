//! Persist speaker analysis alongside the original recording, without rewriting its text.
use std::{collections::BTreeMap, path::{Path, PathBuf}, time::{Duration, UNIX_EPOCH}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use crate::{database::repositories::meeting::MeetingsRepository, state::AppState};

static CHANGES: Mutex<()> = Mutex::const_new(());
const SERVICE: &str = "http://127.0.0.1:8765";

#[derive(Debug, Serialize, Deserialize)]
pub struct SpeakerState {
    pub job: Value,
    pub source_fingerprint: String,
    #[serde(default)]
    pub names: BTreeMap<i32, String>,
    #[serde(default)]
    pub overrides: BTreeMap<String, Option<i32>>,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3)).timeout(Duration::from_secs(10))
        .build().map_err(|e| e.to_string())
}

async fn response(request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(body["detail"].as_str().unwrap_or("Speaker service failed").to_string()) }
    Ok(body)
}

async fn source(state: &AppState, meeting_id: &str) -> Result<(PathBuf, Value, String), String> {
    let pool = state.db_manager.pool();
    let metadata = MeetingsRepository::get_meeting_metadata(pool, meeting_id).await
        .map_err(|e| e.to_string())?.ok_or("Meeting not found")?;
    let folder = PathBuf::from(metadata.folder_path.ok_or("Meeting has no saved recording")?);
    let audio = folder.join("audio.mp4");
    let file = audio.metadata().map_err(|e| e.to_string())?;
    let mut meeting = MeetingsRepository::get_meeting(pool, meeting_id).await
        .map_err(|e| e.to_string())?.ok_or("Meeting not found")?;
    meeting.transcripts.sort_by(|a, b| a.audio_start_time.partial_cmp(&b.audio_start_time)
        .unwrap_or(std::cmp::Ordering::Equal).then(a.id.cmp(&b.id)));
    let mut segments = Vec::new();
    for t in meeting.transcripts {
        let start = t.audio_start_time.ok_or("Transcript has no audio timestamp; retranscribe first")?;
        let end = t.audio_end_time.ok_or("Transcript has no audio timestamp; retranscribe first")?;
        segments.push(json!({"id": t.id, "text": t.text, "audio_start_time": start, "audio_end_time": end}));
    }
    let request = json!({"meeting_id": meeting_id, "audio_path": audio, "segments": segments});
    let modified = file.modified().map_err(|e| e.to_string())?.duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?.as_nanos();
    let fingerprint = format!("{:x}", Sha256::digest(format!("{}:{}:{}", request, file.len(), modified).as_bytes()));
    Ok((folder.join("speakers.json"), request, fingerprint))
}

fn read(path: &Path) -> Result<Option<SpeakerState>, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn save(path: &Path, state: &SpeakerState) -> Result<(), String> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("Missing recording folder")?)
        .map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut file, state).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

fn job_id(state: &SpeakerState) -> Result<&str, String> {
    let id = state.job["job_id"].as_str().ok_or("Missing speaker job ID")?;
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("Invalid speaker job ID".into()) }
    Ok(id)
}

fn bind_live_result(mut job: Value, request: &Value) -> Result<Value, String> {
    if job["status"] != "completed" { return Ok(job); }
    let originals = request["segments"].as_array().ok_or("Missing saved segments")?;
    let live = job["result"]["source_segments"].as_array().ok_or("Missing live transcript provenance")?;
    let same = originals.len() == live.len() && originals.iter().zip(live).all(|(saved, streamed)| {
        saved["text"] == streamed["text"] && ["audio_start_time", "audio_end_time"].iter().all(|key| {
            match (saved[*key].as_f64(), streamed[*key].as_f64()) {
                (Some(a), Some(b)) => (a-b).abs() <= 1e-6,
                _ => false,
            }
        })
    });
    if !same { return Err("Live speaker transcript does not match the saved meeting".into()); }
    let turns = job["result"]["turns"].as_array().ok_or("Missing live speaker turns")?;
    let mut annotations = Vec::new();
    for row in originals {
        let start = row["audio_start_time"].as_f64().ok_or("Missing segment start")?;
        let end = row["audio_end_time"].as_f64().ok_or("Missing segment end")?;
        let mut intervals = Vec::new();
        let mut speakers = std::collections::BTreeSet::new();
        for turn in turns {
            let lo = turn["start"].as_f64().ok_or("Missing speaker start")?;
            let hi = turn["end"].as_f64().ok_or("Missing speaker end")?;
            let speaker = turn["speaker"].as_i64().ok_or("Missing speaker ID")?;
            if hi > start && lo < end {
                intervals.push(json!({"start":start.max(lo),"end":end.min(hi),"speaker":speaker}));
                speakers.insert(speaker);
            }
        }
        annotations.push(json!({"segment_id":row["id"],"speaker_ids":speakers,
            "needs_review":speakers.len()!=1,"intervals":intervals}));
    }
    job["result"]["segments"] = json!(annotations);
    job["meeting_id"] = request["meeting_id"].clone();
    Ok(job)
}

fn labels(state: &SpeakerState) -> Result<BTreeMap<String, String>, String> {
    let name = |id: i32| state.names.get(&id).cloned().unwrap_or_else(|| format!("说话人 {id}"));
    let mut labels = BTreeMap::new();
    for segment in state.job["result"]["segments"].as_array().ok_or("Missing speaker segments")? {
        let id = segment["segment_id"].as_str().ok_or("Missing segment ID")?;
        let label = match state.overrides.get(id) {
            Some(Some(speaker)) => format!("{}（人工）", name(*speaker)),
            Some(None) => "未确认（人工）".into(),
            None => {
                let speakers = segment["speaker_ids"].as_array().ok_or("Missing speaker IDs")?;
                let mut names = Vec::new();
                for speaker in speakers {
                    let speaker = i32::try_from(speaker.as_i64().ok_or("Invalid speaker ID")?).map_err(|e| e.to_string())?;
                    names.push(name(speaker));
                }
                if names.is_empty() { "待确认".into() }
                else { names.join(" / ") + if segment["needs_review"] == true { " · 待校正" } else { "" } }
            }
        };
        labels.insert(id.into(), label);
    }
    Ok(labels)
}

pub async fn labels_for_export(state: &AppState, meeting_id: &str) -> Result<BTreeMap<String, String>, String> {
    let metadata = MeetingsRepository::get_meeting_metadata(state.db_manager.pool(), meeting_id).await
        .map_err(|e| e.to_string())?.ok_or("Meeting not found")?;
    let Some(folder) = metadata.folder_path else { return Ok(BTreeMap::new()) };
    let path = Path::new(&folder).join("speakers.json");
    let Some(saved) = read(&path)? else { return Ok(BTreeMap::new()) };
    if saved.job["status"] != "completed" || !Path::new(&folder).join("audio.mp4").is_file() {
        return Ok(BTreeMap::new())
    }
    let (_, _, fingerprint) = source(state, meeting_id).await?;
    if saved.source_fingerprint != fingerprint { return Ok(BTreeMap::new()) }
    labels(&saved)
}

#[tauri::command]
pub async fn speaker_service_available() -> Result<bool, String> {
    Ok(response(client()?.get(format!("{SERVICE}/health"))).await?["speakers_available"] == true)
}

#[tauri::command]
pub async fn start_meeting_speakers(state: tauri::State<'_, AppState>, meeting_id: String) -> Result<SpeakerState, String> {
    let _engine_lifecycle_guard = crate::audio::common::try_acquire_engine_lifecycle_lock()?;
    let _guard = CHANGES.lock().await;
    if crate::audio::recording_commands::is_recording().await { return Err("Stop recording before analyzing speakers".into()) }
    let (path, request, fingerprint) = source(&state, &meeting_id).await?;
    if let Some(old) = read(&path)? {
        if old.job["status"] == "running" { return Err("Speaker analysis is already running".into()) }
        // Preserve earlier model output and manual corrections when rerunning.
        let backup = path.with_file_name(format!("speakers-{}.json", job_id(&old)?));
        std::fs::copy(&path, backup).map_err(|e| e.to_string())?;
    }
    let job = response(client()?.post(format!("{SERVICE}/v1/speakers")).json(&request)).await?;
    let result = SpeakerState { job, source_fingerprint: fingerprint, names: BTreeMap::new(), overrides: BTreeMap::new() };
    job_id(&result)?;
    if let Err(error) = save(&path, &result) {
        let _ = response(client()?.post(format!("{SERVICE}/v1/speakers/{}/cancel", job_id(&result)?))).await;
        return Err(error);
    }
    log::info!("Speaker analysis started: meeting={} job={}", meeting_id, job_id(&result)?);
    Ok(result)
}

#[tauri::command]
pub async fn get_meeting_speakers(state: tauri::State<'_, AppState>, meeting_id: String) -> Result<Option<SpeakerState>, String> {
    let _guard = CHANGES.lock().await;
    let (path, request, fingerprint) = source(&state, &meeting_id).await?;
    let mut saved = match read(&path)? {
        Some(saved) => saved,
        None => {
            let live_path = path.with_file_name("speakers-live.json");
            if !live_path.is_file() { return Ok(None); }
            let mut job: Value = serde_json::from_slice(&std::fs::read(&live_path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            match bind_live_result(job.clone(), &request) {
                Ok(bound) => job = bound,
                Err(error) => { job["status"] = json!("stale"); job["error"] = json!(error); }
            }
            let saved = SpeakerState { job, source_fingerprint: fingerprint.clone(), names: BTreeMap::new(), overrides: BTreeMap::new() };
            save(&path, &saved)?;
            if saved.job["status"] == "completed" {
                if let Some(started) = saved.job["recording_stop_unix_ms"].as_u64() {
                    let now = std::time::SystemTime::now().duration_since(UNIX_EPOCH)
                        .map_err(|e| e.to_string())?.as_millis() as u64;
                    log::info!("Speaker transcript persisted: meeting={} stop_to_persist_s={:.3}",
                        meeting_id, now.saturating_sub(started) as f64 / 1000.0);
                }
            }
            saved
        }
    };
    if saved.job["status"] == "running" {
        saved.job = response(client()?.get(format!("{SERVICE}/v1/speakers/{}", job_id(&saved)?))).await?;
        save(&path, &saved)?;
    }
    if saved.source_fingerprint != fingerprint {
        saved.job["status"] = json!("stale");
        saved.job["result"] = Value::Null;
        saved.job["error"] = json!("Recording or transcript changed; run speaker analysis again");
    }
    Ok(Some(saved))
}

#[tauri::command]
pub async fn cancel_meeting_speakers(state: tauri::State<'_, AppState>, meeting_id: String) -> Result<(), String> {
    let _guard = CHANGES.lock().await;
    let (path, _, _) = source(&state, &meeting_id).await?;
    if let Some(saved) = read(&path)? {
        response(client()?.post(format!("{SERVICE}/v1/speakers/{}/cancel", job_id(&saved)?))).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn correct_meeting_speaker(state: tauri::State<'_, AppState>, meeting_id: String,
    segment_id: String, speaker_id: Option<i32>, restore_model: bool) -> Result<SpeakerState, String> {
    let _guard = CHANGES.lock().await;
    let (path, _, fingerprint) = source(&state, &meeting_id).await?;
    let mut saved = read(&path)?.ok_or("No speaker analysis")?;
    if saved.job["status"] != "completed" || saved.source_fingerprint != fingerprint { return Err("Complete current speaker analysis first".into()) }
    let result = &saved.job["result"];
    if !result["segments"].as_array().ok_or("Missing speaker segments")?.iter().any(|s| s["segment_id"] == segment_id) {
        return Err("Transcript segment not found".into())
    }
    if let Some(speaker) = speaker_id {
        if !result["turns"].as_array().ok_or("Missing speaker turns")?.iter().any(|t| t["speaker"] == speaker) {
            return Err("Speaker not found".into())
        }
    }
    if restore_model { saved.overrides.remove(&segment_id); } else { saved.overrides.insert(segment_id, speaker_id); }
    save(&path, &saved)?;
    Ok(saved)
}

#[tauri::command]
pub async fn name_meeting_speaker(state: tauri::State<'_, AppState>, meeting_id: String,
    speaker_id: i32, name: String) -> Result<SpeakerState, String> {
    let _guard = CHANGES.lock().await;
    let (path, _, fingerprint) = source(&state, &meeting_id).await?;
    let mut saved = read(&path)?.ok_or("No speaker analysis")?;
    if saved.job["status"] != "completed" || saved.source_fingerprint != fingerprint { return Err("Complete current speaker analysis first".into()) }
    if !saved.job["result"]["turns"].as_array().ok_or("Missing speaker turns")?.iter().any(|t| t["speaker"] == speaker_id) {
        return Err("Speaker not found".into())
    }
    let name = name.trim();
    if name.chars().count() > 80 { return Err("Speaker name is too long".into()) }
    if name.is_empty() { saved.names.remove(&speaker_id); } else { saved.names.insert(speaker_id, name.into()); }
    save(&path, &saved)?;
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_result_binds_new_database_ids_only_when_source_matches() {
        let source = json!({"meeting_id":"saved-meeting", "segments":[
            {"id":"database-id","text":"原文","audio_start_time":1.0,"audio_end_time":3.0}]});
        let job = json!({"status":"completed","result":{
            "source_segments":[{"id":"seg_3","text":"原文","audio_start_time":1.0,"audio_end_time":3.0}],
            "turns":[{"start":1.0,"end":2.0,"speaker":1},{"start":2.0,"end":3.0,"speaker":2}]}});
        let bound = bind_live_result(job.clone(), &source).unwrap();
        assert_eq!(bound["result"]["turns"], job["result"]["turns"]);
        assert_eq!(bound["result"]["segments"][0]["segment_id"], "database-id");
        assert_eq!(bound["result"]["segments"][0]["speaker_ids"], json!([1,2]));
        assert_eq!(bound["result"]["segments"][0]["needs_review"], true);
        let mut changed = source.clone();
        changed["segments"][0]["text"] = json!("different text");
        assert!(bind_live_result(job.clone(), &changed).is_err());
        changed = source.clone();
        changed["segments"][0]["audio_end_time"] = json!(4.0);
        assert!(bind_live_result(job.clone(), &changed).is_err());
        changed["segments"] = json!([]);
        assert!(bind_live_result(job, &changed).is_err());
    }

    #[test]
    fn speaker_corrections_persist_separately_from_model_output() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("speakers.json");
        let mut state = SpeakerState { job: json!({"job_id": "a".repeat(32), "status": "completed", "result": {
            "turns": [{"speaker": 1}], "segments": [{"segment_id": "seg1", "speaker_ids": [1], "needs_review": false}]}}),
            source_fingerprint: "original".into(), names: BTreeMap::new(), overrides: BTreeMap::new() };
        save(&path, &state).unwrap();
        state.names.insert(1, "手动名称".into());
        state.overrides.insert("seg1".into(), None);
        save(&path, &state).unwrap();
        let loaded = read(&path).unwrap().unwrap();
        assert_eq!(loaded.job, state.job);
        assert_eq!(loaded.names[&1], "手动名称");
        assert_eq!(loaded.overrides["seg1"], None);
        assert_eq!(labels(&loaded).unwrap()["seg1"], "未确认（人工）");
        assert_eq!(job_id(&loaded).unwrap(), "a".repeat(32));
    }

    #[test]
    fn export_preserves_ambiguous_speakers_and_manual_names() {
        let state = SpeakerState { job: json!({"result": {"segments": [
            {"segment_id": "mixed", "speaker_ids": [1, 2], "needs_review": true},
            {"segment_id": "unknown", "speaker_ids": [], "needs_review": true}
        ]}}), source_fingerprint: "source".into(),
            names: BTreeMap::from([(1, "甲".into())]), overrides: BTreeMap::new() };
        let labels = labels(&state).unwrap();
        assert_eq!(labels["mixed"], "甲 / 说话人 2 · 待校正");
        assert_eq!(labels["unknown"], "待确认");
    }
}
