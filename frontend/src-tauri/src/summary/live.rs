//! Connect immutable speaker batches to chunk notes and section-wise final summaries.
use std::{collections::HashMap, io::{BufWriter, Write}, path::{Path, PathBuf}, process::Stdio,
    sync::{Arc, LazyLock, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tauri::{Manager, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::ChildStdin;
use crate::database::repositories::{meeting::MeetingsRepository, setting::SettingsRepository,
    summary::SummaryProcessesRepository};

const MODEL: &str = "qwen3.5:4b";
const WORKFLOW: &str = "section-notes-v1";
struct Session {
    directory: PathBuf, alive: Arc<AtomicBool>, stopped_at: Option<i64>, snapshot: Value,
    // Closing stdin on application exit also stops the worker and its model child.
    _stdin: Option<ChildStdin>,
    progress: Value,
}
static SESSIONS: LazyLock<Mutex<HashMap<String, Session>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn read(path: &Path) -> Result<Value, String> {
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn write(path: &Path, value: &Value) -> Result<(), String> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("Missing workflow directory")?)
        .map_err(|e| e.to_string())?;
    // A meeting snapshot contains many small JSON tokens. Buffer them before
    // writing so publishing text does not hold up the live audio sender.
    {
        let mut writer = BufWriter::new(&mut file);
        serde_json::to_writer_pretty(&mut writer, value).map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
    }
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let deadline = std::time::Instant::now() + Duration::from_millis(250);
    loop {
        match file.persist(path) {
            Ok(_) => return Ok(()),
            Err(error) => {
                // Windows readers/scanners can briefly deny atomic replacement.
                // Keep the complete temporary file and retry without removing the old snapshot.
                #[cfg(windows)]
                if matches!(error.error.raw_os_error(), Some(5 | 32 | 33))
                    && std::time::Instant::now() < deadline
                {
                    file = error.file;
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                return Err(error.to_string());
            }
        }
    }
}

#[derive(Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Debug, Default)]
#[serde(rename_all = "snake_case")]
pub enum SummaryModelChoice { #[default] Builtin, Intranet }

fn model_choice(path: &Path) -> Result<SummaryModelChoice, String> {
    if !path.exists() { return Ok(SummaryModelChoice::Builtin); }
    serde_json::from_value(read(path)?).map_err(|e| format!("无法读取总结模型设置：{e}"))
}
#[tauri::command]
pub fn get_summary_model<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<SummaryModelChoice, String> {
    model_choice(&app.path().app_data_dir().map_err(|e| e.to_string())?.join("summary-model.json"))
}
#[tauri::command]
pub fn set_summary_model<R: tauri::Runtime>(app: tauri::AppHandle<R>, model: SummaryModelChoice) -> Result<(), String> {
    let folder = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    write(&folder.join("summary-model.json"), &json!(model))
}

pub async fn begin<R: tauri::Runtime>(app: &tauri::AppHandle<R>, job_id: &str) -> Result<(), String> {
    let _start_guard = super::commands::SUMMARY_START_LOCK.lock().await;
    begin_unlocked(app, job_id).await
}

async fn begin_unlocked<R: tauri::Runtime>(app: &tauri::AppHandle<R>, job_id: &str) -> Result<(), String> {
    let state = app.state::<crate::state::AppState>();
    let config = SettingsRepository::get_model_config(state.db_manager.pool()).await.map_err(|e| e.to_string())?;
    let openvino = std::env::var("MEETILY_WORKFLOW_BACKEND").as_deref() == Ok("openvino");
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let choice = model_choice(&app_data.join("summary-model.json"))?;
    if choice == SummaryModelChoice::Builtin && !openvino
        && !config.is_some_and(|c| c.provider == "builtin-ai" && c.model == MODEL) { return Ok(()); }
    let directory = app_data.join("recording-summaries").join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(directory.join("runtime")).map_err(|e| e.to_string())?;
    let alive = Arc::new(AtomicBool::new(false));
    let busy = {
        let mut sessions = SESSIONS.lock().unwrap();
        // Keep the small directory handle until the frontend attaches the saved meeting,
        // even if another recording starts immediately. Discard old in-memory audio text.
        for session in sessions.values_mut().filter(|s| !s.alive.load(Ordering::SeqCst)) {
            session.snapshot = Value::Null;
            session._stdin.take();
        }
        sessions.values().any(|s| s.alive.load(Ordering::SeqCst))
    };
    SESSIONS.lock().unwrap().insert(job_id.into(), Session {
        directory: directory.clone(), alive: alive.clone(), stopped_at: None,
        snapshot: json!({"status":"running"}), _stdin: None,
        progress: json!({"seq":0,"phase":"waiting_transcripts","current":null,"notes":[],"chapters":[]}),
    });
    let result: Result<(), String> = async {
        if busy || super::service::SummaryService::has_active_summary() {
            return Err("Previous summary is still running; recording and transcription continue".into());
        }
        let node = std::env::var_os("MEETILY_WORKFLOW_NODE").ok_or("Configure MEETILY_WORKFLOW_NODE for the offline summary runtime")?;
        macro_rules! source { ($name:literal) => {
            ($name, include_str!(concat!("../../resources/summary-workflow/", $name)))
        }; }
        for (name, source) in [source!("live.mjs"), source!("round.mjs"), source!("runtime.mjs"),
            source!("prompt.mjs"), source!("facts.mjs"), source!("text-facts.mjs"),
            source!("workflow-submissions.mjs"), source!("relevant-memory.mjs"),
            source!("sections.mjs"), source!("generation.mjs"), source!("progress.mjs"),
            source!("runtime-openvino.mjs"), source!("runtime-intranet.mjs"), source!("openvino-server.py")] {
            std::fs::write(directory.join("runtime").join(name), source).map_err(|e| e.to_string())?;
        }
        // Release any idle built-in summary model before reserving this recording's model.
        super::summary_engine::client::force_shutdown_sidecar().await.map_err(|e| e.to_string())?;
        let mut memory = sysinfo::System::new();
        memory.refresh_memory();
        write(&directory.join("memory.json"), &json!({"available_bytes":memory.available_memory()}))?;
        let mut command = tokio::process::Command::new(node);
        if choice == SummaryModelChoice::Intranet {
            command.env("MEETILY_WORKFLOW_BACKEND", "intranet")
                .env("MEETILY_INTRANET_CONFIG", std::env::var_os("MEETILY_INTRANET_CONFIG")
                    .map(PathBuf::from).unwrap_or(app_data.join("intranet-model.json")));
        } else {
            let server = std::env::var_os("MEETILY_WORKFLOW_SERVER").ok_or("本地总结服务未配置")?;
            let model = std::env::var_os("MEETILY_WORKFLOW_MODEL").map(PathBuf::from)
                .unwrap_or(super::summary_engine::models::get_model_path(&app_data, MODEL).map_err(|e| e.to_string())?);
            if !model.is_file() { return Err("本地总结模型文件不可用".into()); }
            command.env("MEETILY_WORKFLOW_SERVER", server).env("MEETILY_WORKFLOW_MODEL", model);
        }
        write(&directory.join("selected-model.json"), &json!(choice))?;
        // Manual regeneration can begin finalization before Node writes its first snapshot.
        write(&directory.join("state.json"), &json!({"status":"starting","workflow":WORKFLOW}))?;
        command.arg(directory.join("runtime/live.mjs")).arg(&directory)
            .stdin(Stdio::piped()).stdout(Stdio::piped())
            .stderr(std::fs::File::create(directory.join("worker.stderr.log")).map_err(|e| e.to_string())?);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        alive.store(true, Ordering::SeqCst);
        SESSIONS.lock().unwrap().get_mut(job_id).unwrap()._stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or("Missing summary progress pipe")?;
        let progress_app = app.clone();
        let progress_job = job_id.to_owned();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(mut event) = serde_json::from_str::<Value>(&line) else { continue };
                let accepted = {
                    let mut sessions = SESSIONS.lock().unwrap();
                    let Some(session) = sessions.get_mut(&progress_job) else { break };
                    apply_progress(&mut session.progress, &event)
                };
                if accepted {
                    event["job_id"] = json!(progress_job);
                    let _ = progress_app.emit("meeting-summary-progress", event);
                }
            }
        });
        let folder = directory.clone();
        tokio::spawn(async move {
            let result = loop {
                tokio::select! {
                    result = child.wait() => break result,
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {
                        memory.refresh_memory();
                        let _ = write(&folder.join("memory.json"), &json!({"available_bytes":memory.available_memory()}));
                    }
                }
            };
            alive.store(false, Ordering::SeqCst);
            let path = folder.join("state.json");
            let mut state = read(&path).unwrap_or(json!({"completed_batches":0,"queued_batches":0}));
            if state["status"] != "ready" && state["status"] != "failed" {
                state["status"] = json!("failed");
                state["error"] = json!(format!("Summary worker exited before completion: {result:?}"));
                let _ = write(&path, &state);
            }
        });
        Ok(())
    }.await;
    if let Err(error) = &result {
        write(&directory.join("state.json"), &json!({"status":"failed", "error":error,
            "completed_batches":0,"queued_batches":0}))?;
    }
    result
}

fn apply_progress(snapshot: &mut Value, event: &Value) -> bool {
    if snapshot["phase"] == "completed" { return false; }
    let seq = event["seq"].as_u64().unwrap_or(0);
    if seq <= snapshot["seq"].as_u64().unwrap_or(0) { return false; }
    if event["kind"] == "snapshot" { *snapshot = event.clone(); }
    else if event["kind"] == "delta" {
        if seq != snapshot["seq"].as_u64().unwrap_or(0) + 1
            || event["request_id"] != snapshot["current"]["request_id"] { return false; }
        let mut draft = snapshot["current"]["draft"].as_str().unwrap_or("").to_owned();
        draft.push_str(event["text"].as_str().unwrap_or(""));
        snapshot["current"]["draft"] = json!(draft);
        snapshot["seq"] = json!(seq);
    } else { return false; }
    true
}

fn finish_progress<R: tauri::Runtime>(app: &tauri::AppHandle<R>, job_id: &str, error: Option<&str>) {
    let value = {
        let mut sessions = SESSIONS.lock().unwrap();
        let Some(session) = sessions.get_mut(job_id) else { return };
        session.progress["seq"] = json!(session.progress["seq"].as_u64().unwrap_or(0) + 1);
        session.progress["phase"] = json!(if error.is_some() { "failed" } else { "completed" });
        session.progress["current"] = Value::Null;
        session.progress["error"] = json!(error);
        session.progress["job_id"] = json!(job_id);
        session.progress["kind"] = json!("snapshot");
        session.progress.clone()
    };
    let _ = app.emit("meeting-summary-progress", value);
}

#[tauri::command]
pub async fn get_summary_progress(state: tauri::State<'_, crate::state::AppState>, meeting_id: Option<String>, known: Option<Value>) -> Result<Option<Value>, String> {
    let pool = state.db_manager.pool();
    let saved_manifest = if let Some(id) = &meeting_id { manifest(pool, id).await? } else { None };
    let job = if meeting_id.is_some() {
        saved_manifest.as_ref().and_then(|m| m["job_id"].as_str()).map(str::to_owned)
    } else { crate::live_speakers::recording_job_id() };
    let Some(job_id) = job else { return Ok(None) };
    let memory = SESSIONS.lock().unwrap().get(&job_id).map(|s| (s.progress.clone(), s.directory.clone(), s.alive.load(Ordering::SeqCst)));
    let known_session = memory.is_some();
    let (mut value, directory, alive) = if let Some(value) = memory { value }
    else {
        let directory = PathBuf::from(saved_manifest.as_ref().and_then(|m| m["run_directory"].as_str()).ok_or("Missing summary directory")?);
        (read(&directory.join("progress.json")).unwrap_or(json!({"seq":0,"phase":"failed"})), directory, false)
    };
    if let Some(id) = &meeting_id {
        if let Some(saved) = SummaryProcessesRepository::get_summary_data(pool, id).await.map_err(|e| e.to_string())? {
            if saved.status == "completed" { value["phase"] = json!("completed"); value["current"] = Value::Null; }
            else if saved.status == "failed" { value["phase"] = json!("failed"); }
        }
    }
    if value["phase"] != "completed" {
        if let Ok(worker) = read(&directory.join("state.json")) {
            if worker["status"] == "failed" {
                value["phase"] = json!("failed"); value["error"] = worker["error"].clone(); value["current"] = Value::Null;
            } else if !alive && (worker["status"] != "ready" || !known_session) {
                value["phase"] = json!("failed"); value["error"] = json!("总结任务已停止，原始转写和已完成笔记已保留。"); value["current"] = Value::Null;
            }
        }
    }
    value["job_id"] = json!(job_id);
    value["meeting_id"] = json!(meeting_id);
    Ok(changed_progress(value, known.as_ref()))
}

fn changed_progress(value: Value, known: Option<&Value>) -> Option<Value> {
    // Check after the database lookup: saving -> completed can keep the file's sequence.
    if known.is_some_and(|known| ["job_id", "seq", "phase"].iter().all(|key| known[*key] == value[*key])) {
        None
    } else { Some(value) }
}

fn send(session: &Session) -> Result<(), String> {
    let mut snapshot = session.snapshot.clone();
    snapshot["recording_stopped_at"] = json!(session.stopped_at);
    write(&session.directory.join("input.json"), &snapshot)
}
pub fn offer(job_id: &str, snapshot: &Value) {
    if let Some(session) = SESSIONS.lock().unwrap().get_mut(job_id) {
        if !session.alive.load(Ordering::SeqCst) { return; }
        session.snapshot = snapshot.clone();
        if let Err(error) = send(session) {
            let _ = std::fs::write(session.directory.join("cancel"), error.as_bytes());
            log::warn!("Could not publish summary input: {error}");
        }
    }
}
pub fn recording_stopped(job_id: &str) {
    if let Some(session) = SESSIONS.lock().unwrap().get_mut(job_id) {
        session.stopped_at.get_or_insert(chrono::Utc::now().timestamp_millis());
        let _ = send(session);
    }
}
pub fn attach_folder(job_id: &str, folder: &Path) -> Result<(), String> {
    if let Some(session) = SESSIONS.lock().unwrap().get(job_id) {
        write(&folder.join("summary-live.json"), &json!({"job_id":job_id,"workflow":WORKFLOW,
            "run_directory":session.directory}))?;
    }
    Ok(())
}
pub fn status(job_id: &str) -> Option<Value> {
    SESSIONS.lock().unwrap().get(job_id).map(|session| {
        let value = read(&session.directory.join("state.json")).unwrap_or(json!({"status":"starting"}));
        json!({"status":value["status"],"workflow":value["workflow"],"completed_batches":value["completed_batches"].as_u64().unwrap_or(0),
            "queued_batches":value["queued_batches"].as_u64().unwrap_or(0),
            "failed_batches":value["failed_batches"].as_u64().unwrap_or(0), "error":value["error"],
            "phase":value["phase"],"completed_notes":value["notes"].as_array().map_or(0,Vec::len),
            "pending_characters":value["pending_characters"]})
    })
}
pub fn cancel(job_id: &str) {
    if let Some(session) = SESSIONS.lock().unwrap().get(job_id) {
        let _ = std::fs::write(session.directory.join("cancel"), b"cancelled");
    }
}

pub async fn shutdown() {
    let workers = {
        let mut sessions = SESSIONS.lock().unwrap();
        sessions.values_mut().map(|session| {
            let _ = std::fs::write(session.directory.join("cancel"), b"application exiting");
            session._stdin.take();
            session.alive.clone()
        }).collect::<Vec<_>>()
    };
    let deadline = tokio::time::Instant::now()+Duration::from_secs(5);
    while workers.iter().any(|alive| alive.load(Ordering::SeqCst)) && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn manifest(pool: &SqlitePool, meeting_id: &str) -> Result<Option<Value>, String> {
    let Some(metadata) = MeetingsRepository::get_meeting_metadata(pool, meeting_id).await.map_err(|e| e.to_string())?
        else { return Ok(None) };
    let Some(folder) = metadata.folder_path else { return Ok(None) };
    let path = Path::new(&folder).join("summary-live.json");
    if !path.is_file() { return Ok(None); }
    let value = read(&path)?;
    Ok(matches!(value["workflow"].as_str(), Some("fixed-facts-v1" | "section-notes-v1")).then_some(value))
}

pub async fn cancel_meeting(pool: &SqlitePool, meeting_id: &str) -> Result<(), String> {
    if let Some(value) = manifest(pool, meeting_id).await? {
        if let Some(id) = value["job_id"].as_str() { cancel(id); }
        if let Some(directory) = value["run_directory"].as_str() {
            std::fs::write(Path::new(directory).join("cancel"), b"cancelled").map_err(|e| e.to_string())?;
        }
    }
    // A manually regenerated report must not load another model while a live worker drains.
    let deadline = tokio::time::Instant::now()+Duration::from_secs(5);
    while SESSIONS.lock().unwrap().values().any(|s| s.alive.load(Ordering::SeqCst)) {
        if tokio::time::Instant::now() >= deadline {
            return Err("A recording summary is still active; finish or cancel it before generating another report".into());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(())
}

fn validate_sources(originals: &[Value], sources: &Value) -> Result<(), String> {
    let sources = sources.as_array().ok_or("Missing incremental summary source snapshot")?;
    if originals.len() != sources.len() || originals.iter().zip(sources).any(|(a,b)| {
        a["text"] != b["text"] || ["audio_start_time","audio_end_time"].iter().any(|k|
            !matches!((a[k].as_f64(),b[k].as_f64()),(Some(a),Some(b)) if (a-b).abs() <= 1e-6))
    }) { return Err("Transcript changed after incremental summarization; regenerate from the edited transcript".into()); }
    Ok(())
}

async fn save_report(pool: &SqlitePool, meeting_id: &str, started: chrono::DateTime<chrono::Utc>, value: &Value) -> Result<(), String> {
    let meeting = MeetingsRepository::get_meeting(pool, meeting_id).await
        .map_err(|e| e.to_string())?.ok_or("Meeting not found")?;
    let mut rows = meeting.transcripts.iter().collect::<Vec<_>>();
    rows.sort_by(|a,b| a.audio_start_time.partial_cmp(&b.audio_start_time)
        .unwrap_or(std::cmp::Ordering::Equal).then(a.id.cmp(&b.id)));
    let rows = rows.into_iter().map(|r| json!({"text":r.text,
        "audio_start_time":r.audio_start_time,"audio_end_time":r.audio_end_time})).collect::<Vec<_>>();
    validate_sources(&rows, &value["source_segments"])?;
    let markdown = value["markdown"].as_str().filter(|s| !s.trim().is_empty()).ok_or("Missing report")?;
    SummaryProcessesRepository::update_process_completed(pool, meeting_id, started,
        json!({"markdown":markdown,"workflow":value["workflow"],"model":value["model"],"semantic_quality_verified":false,
            "within_post_stop_target":value["within_post_stop_target"]}),
        value["completed_batches"].as_i64().unwrap_or(0),
        value["settled_seconds_after_stop"].as_f64().unwrap_or(0.0)).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn finalize_recording_summary<R: tauri::Runtime>(
    app: tauri::AppHandle<R>, state: tauri::State<'_, crate::state::AppState>, meeting_id: String,
) -> Result<bool, String> {
    let _start_guard = super::commands::SUMMARY_START_LOCK.lock().await;
    finalize_unlocked(app, state.db_manager.pool().clone(), meeting_id, false).await
}

async fn finalize_unlocked<R: tauri::Runtime>(app: tauri::AppHandle<R>, pool: SqlitePool, meeting_id: String, restart: bool) -> Result<bool, String> {
    let Some(manifest) = manifest(&pool, &meeting_id).await? else { return Ok(false) };
    let directory = PathBuf::from(manifest["run_directory"].as_str().ok_or("Missing workflow directory")?);
    let job_id = manifest["job_id"].as_str().ok_or("Missing workflow job ID")?.to_owned();
    if let Some(existing) = SummaryProcessesRepository::get_summary_data(&pool, &meeting_id).await.map_err(|e| e.to_string())? {
        if !restart && (existing.status.eq_ignore_ascii_case("pending") || existing.status == "completed") { return Ok(true); }
    }
    let started = chrono::Utc::now();
    SummaryProcessesRepository::create_or_reset_process(&pool, &meeting_id, started).await.map_err(|e| e.to_string())?;
    let cancellation = super::service::SummaryService::register_cancellation_token(&meeting_id, started);
    tokio::spawn(async move {
        let result: Result<(), String> = async {
            // Experimental section close is allowed to finish so its real cost can be measured.
            // The worker reports the original 120-second target separately from this hard limit.
            let limit = if manifest["workflow"] == WORKFLOW { 1805 } else { 125 };
            let deadline = tokio::time::Instant::now()+Duration::from_secs(limit);
            loop {
                if cancellation.is_cancelled() { cancel(&job_id); return Err("Summary generation cancelled".into()); }
                let process = SummaryProcessesRepository::get_summary_data(&pool, &meeting_id).await.map_err(|e| e.to_string())?;
                if !process.is_some_and(|p| p.start_time == Some(started) && p.status.eq_ignore_ascii_case("pending")) {
                    cancel(&job_id); return Ok(());
                }
                let value = read(&directory.join("state.json"))?;
                match value["status"].as_str() {
                    Some("ready") => {
                        save_report(&pool, &meeting_id, started, &value).await?;
                        finish_progress(&app, &job_id, None);
                        return Ok(());
                    }
                    Some("failed") => return Err(value["error"].as_str().unwrap_or("Incremental summaries are incomplete").into()),
                    _ => {}
                }
                let active = SESSIONS.lock().unwrap().get(&job_id).is_some_and(|s| s.alive.load(Ordering::SeqCst));
                if !active { return Err("Summary worker is no longer active; partial draft is preserved".into()); }
                if tokio::time::Instant::now() > deadline { cancel(&job_id); return Err("Summary drain timed out".into()); }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }.await;
        if let Err(error) = result {
            let _ = SummaryProcessesRepository::update_process_failed(&pool, &meeting_id, started, &error).await;
            finish_progress(&app, &job_id, Some(&error));
        }
        super::service::SummaryService::cleanup_cancellation_token(&meeting_id, started);
    });
    Ok(true)
}

// Manual generation uses the selected runtime too; read current DB text rather than old drafts.
pub async fn regenerate<R: tauri::Runtime>(app: &tauri::AppHandle<R>, pool: &SqlitePool, meeting_id: &str) -> Result<String, String> {
    let _start_guard = super::commands::SUMMARY_START_LOCK.lock().await;
    cancel_meeting(pool, meeting_id).await?;
    let meeting = MeetingsRepository::get_meeting(pool, meeting_id).await.map_err(|e| e.to_string())?.ok_or("会议不存在")?;
    let metadata = MeetingsRepository::get_meeting_metadata(pool, meeting_id).await.map_err(|e| e.to_string())?.ok_or("会议信息不存在")?;
    let folder = metadata.folder_path.ok_or("会议录音目录不存在")?;
    let mut rows = meeting.transcripts.iter().collect::<Vec<_>>();
    rows.sort_by(|a, b| a.audio_start_time.partial_cmp(&b.audio_start_time).unwrap_or(std::cmp::Ordering::Equal).then(a.id.cmp(&b.id)));
    if rows.is_empty() { return Err("暂无可用于总结的转写".into()); }
    let speakers = crate::meeting_speakers::get_meeting_speakers(app.state(), meeting_id.into()).await?;
    let segments = rows.iter().map(|r| {
        let mut ids = json!([]);
        let mut uncertain = json!(true);
        if let Some(saved) = speakers.as_ref().filter(|s| s.job["status"] == "completed") {
            if let Some(annotation) = saved.job["result"]["segments"].as_array()
                .and_then(|items| items.iter().find(|a| a["segment_id"] == r.id)) {
                ids = annotation["speaker_ids"].clone(); uncertain = annotation["needs_review"].clone();
            }
            if let Some(value) = saved.overrides.get(&r.id) {
                ids = json!(value.iter().collect::<Vec<_>>()); uncertain = json!(value.is_none());
            }
        }
        json!({"id":r.id,"text":r.text,"audio_start_time":r.audio_start_time,
            "audio_end_time":r.audio_end_time,"speaker_ids":ids,"needs_review":uncertain})
    }).collect::<Vec<_>>();
    let job = uuid::Uuid::new_v4().to_string();
    begin_unlocked(app, &job).await?;
    attach_folder(&job, Path::new(&folder))?;
    offer(&job, &json!({"status":"completed","result":{"source_segments":segments,
        "batches":[{"batch_id":0,"segments":segments}]}}));
    recording_stopped(&job);
    finalize_unlocked(app.clone(), pool.clone(), meeting_id.into(), true).await?;
    let process = SummaryProcessesRepository::get_summary_data(pool, meeting_id).await.map_err(|e| e.to_string())?.ok_or("总结任务未创建")?;
    Ok(process.start_time.ok_or("总结任务缺少开始时间")?.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
}

#[cfg(test)]
mod tests {
    #[test]
    fn model_choice_defaults_persists_and_rejects_invalid_values() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("summary-model.json");
        assert_eq!(model_choice(&file).unwrap(), SummaryModelChoice::Builtin);
        write(&file, &json!("intranet")).unwrap();
        let fixed_for_meeting = model_choice(&file).unwrap();
        write(&file, &json!("builtin")).unwrap();
        assert_eq!(fixed_for_meeting, SummaryModelChoice::Intranet);
        assert_eq!(model_choice(&file).unwrap(), SummaryModelChoice::Builtin);
        write(&file, &json!("unknown")).unwrap();
        assert!(model_choice(&file).is_err());
    }
    #[test]
    fn unchanged_progress_omits_the_body_but_preserves_job_and_save_transitions() {
        let value = serde_json::json!({"job_id":"a","seq":7,"phase":"saving","notes":["正文"]});
        let known = serde_json::json!({"job_id":"a","seq":7,"phase":"saving"});
        assert!(super::changed_progress(value.clone(), Some(&known)).is_none());
        assert!(super::changed_progress(value.clone(), None).is_some());
        for changed in [serde_json::json!({"job_id":"b","seq":7,"phase":"saving"}),
            serde_json::json!({"job_id":"a","seq":6,"phase":"saving"}),
            serde_json::json!({"job_id":"a","seq":7,"phase":"completed"})] {
            assert!(super::changed_progress(value.clone(), Some(&changed)).is_some());
        }
    }
    use super::*;
    #[test]
    fn progress_rejects_duplicate_and_stale_requests_and_preserves_drafts() {
        let mut snapshot = json!({"seq":1,"phase":"recording_note","current":{"request_id":"a","draft":"甲"}});
        assert!(!apply_progress(&mut snapshot, &json!({"kind":"delta","seq":1,"request_id":"a","text":"重复"})));
        assert!(!apply_progress(&mut snapshot, &json!({"kind":"delta","seq":2,"request_id":"old","text":"旧请求"})));
        assert!(apply_progress(&mut snapshot, &json!({"kind":"delta","seq":2,"request_id":"a","text":"乙"})));
        assert_eq!(snapshot["current"]["draft"], "甲乙");
        assert!(apply_progress(&mut snapshot, &json!({"kind":"snapshot","seq":3,"phase":"saving","current":null})));
        snapshot["phase"] = json!("completed");
        assert!(!apply_progress(&mut snapshot, &json!({"kind":"snapshot","seq":4,"phase":"recording_note"})));
    }
    #[test]
    fn large_snapshot_is_published_completely_and_replaces_previous_revision() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("input.json");
        write(&path, &json!({"revision": 1})).unwrap();
        let value = json!({"revision":2, "segments":(0..625).map(|i|
            json!({"id":i,"text":"保留完整会议文本，包括缓冲区末尾。".repeat(20)}))
            .collect::<Vec<_>>()});
        write(&path, &value).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), serde_json::to_vec_pretty(&value).unwrap());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
    #[cfg(windows)]
    #[test]
    fn snapshot_publish_survives_a_brief_windows_read_lock() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("input.json");
        write(&path, &json!({"revision": 1})).unwrap();
        // A reader without FILE_SHARE_DELETE temporarily prevents replacement.
        let reader = std::fs::OpenOptions::new().read(true).share_mode(1 | 2).open(&path).unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(75));
            drop(reader);
        });
        let result = write(&path, &json!({"revision": 2}));
        release.join().unwrap();
        result.unwrap();
        assert_eq!(read(&path).unwrap(), json!({"revision": 2}));
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn snapshot_publish_keeps_previous_data_when_windows_lock_persists() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("input.json");
        write(&path, &json!({"revision": 1})).unwrap();
        let _reader = std::fs::OpenOptions::new().read(true).share_mode(1 | 2).open(&path).unwrap();
        assert!(write(&path, &json!({"revision": 2})).is_err());
        assert_eq!(read(&path).unwrap(), json!({"revision": 1}));
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn completed_workflow_report_is_saved_reopened_and_protected_from_stale_sources() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1)
            .connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        // folder_path is initialized by the application's legacy schema bootstrap.
        let columns: Vec<(i64,String,String,i64,Option<String>,i64)> =
            sqlx::query_as("PRAGMA table_info(meetings)").fetch_all(&pool).await.unwrap();
        if !columns.iter().any(|c| c.1 == "folder_path") {
            sqlx::query("ALTER TABLE meetings ADD COLUMN folder_path TEXT").execute(&pool).await.unwrap();
        }
        let started = chrono::Utc::now();
        sqlx::query("INSERT INTO meetings (id,title,created_at,updated_at) VALUES ('meeting','会议',?,?)")
            .bind(started).bind(started).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO transcripts (id,meeting_id,transcript,timestamp,audio_start_time,audio_end_time,duration) VALUES ('database-id','meeting','小林提交周报','00:00',0,20,20)")
            .execute(&pool).await.unwrap();
        let value = json!({"status":"ready","workflow":WORKFLOW,"model":"Qwen3-1.7B","within_post_stop_target":true,"markdown":"## 明确待办\n- 小林提交周报。",
            "source_segments":[{"id":"live-id","text":"小林提交周报","audio_start_time":0,"audio_end_time":20}],
            "completed_batches":1,"settled_seconds_after_stop":1.5});
        SummaryProcessesRepository::create_or_reset_process(&pool,"meeting",started).await.unwrap();
        // The public summary endpoint uses this lookup. Live batches do not create
        // the legacy transcript_chunks rows used by full-transcript generation.
        let pending = SummaryProcessesRepository::get_summary_data_for_meeting(&pool,"meeting").await.unwrap().unwrap();
        assert!(pending.status.eq_ignore_ascii_case("pending"));
        save_report(&pool,"meeting",started,&value).await.unwrap();
        let saved = SummaryProcessesRepository::get_summary_data_for_meeting(&pool,"meeting").await.unwrap().unwrap();
        assert_eq!(saved.status,"completed");
        let report: Value = serde_json::from_str(&saved.result.unwrap()).unwrap();
        assert_eq!(report["markdown"],value["markdown"]);
        assert_eq!(report["workflow"],WORKFLOW);
        assert_eq!(report["model"],"Qwen3-1.7B");
        assert_eq!(report["within_post_stop_target"],true);
        assert_eq!(saved.chunk_count,1);
        sqlx::query("UPDATE transcripts SET transcript='人工修改' WHERE id='database-id'")
            .execute(&pool).await.unwrap();
        assert!(save_report(&pool,"meeting",started,&value).await.is_err());
        let reopened = SummaryProcessesRepository::get_summary_data_for_meeting(&pool,"meeting").await.unwrap().unwrap();
        assert_eq!(serde_json::from_str::<Value>(&reopened.result.unwrap()).unwrap()["markdown"],value["markdown"]);
    }
    #[test]
    fn saved_report_requires_identical_text_and_timestamps_not_database_ids() {
        let source = json!([{"id":"live-id","text":"原话","audio_start_time":1.0,"audio_end_time":2.0}]);
        let mut saved = source.as_array().unwrap().clone(); saved[0]["id"] = json!("database-id");
        assert!(validate_sources(&saved, &source).is_ok());
        saved[0]["text"] = json!("用户编辑后的原话");
        assert!(validate_sources(&saved, &source).is_err());
        assert!(validate_sources(&[], &source).is_err());
    }
}
