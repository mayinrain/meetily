//! Connect immutable speaker batches to the fixed-fact workflow, then save its report.
use std::{collections::HashMap, path::{Path, PathBuf}, process::Stdio,
    sync::{Arc, LazyLock, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tauri::Manager;
use tokio::process::ChildStdin;
use crate::database::repositories::{meeting::MeetingsRepository, setting::SettingsRepository,
    summary::SummaryProcessesRepository};

const MODEL: &str = "qwen3.5:4b";
struct Session {
    directory: PathBuf, alive: Arc<AtomicBool>, stopped_at: Option<i64>, snapshot: Value,
    // Closing stdin on application exit also stops the worker and its model child.
    _stdin: Option<ChildStdin>,
}
static SESSIONS: LazyLock<Mutex<HashMap<String, Session>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn read(path: &Path) -> Result<Value, String> {
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn write(path: &Path, value: &Value) -> Result<(), String> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("Missing workflow directory")?)
        .map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut file, value).map_err(|e| e.to_string())?;
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

pub async fn begin<R: tauri::Runtime>(app: &tauri::AppHandle<R>, job_id: &str) -> Result<(), String> {
    let state = app.state::<crate::state::AppState>();
    let config = SettingsRepository::get_model_config(state.db_manager.pool()).await.map_err(|e| e.to_string())?;
    if !config.is_some_and(|c| c.provider == "builtin-ai" && c.model == MODEL) { return Ok(()); }
    let _start_guard = super::commands::SUMMARY_START_LOCK.lock().await;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
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
    });
    let result: Result<(), String> = async {
        if busy || super::service::SummaryService::has_active_summary() {
            return Err("Previous summary is still running; recording and transcription continue".into());
        }
        let node = std::env::var_os("MEETILY_WORKFLOW_NODE").ok_or("Configure MEETILY_WORKFLOW_NODE for the offline summary runtime")?;
        let server = std::env::var_os("MEETILY_WORKFLOW_SERVER").ok_or("Configure MEETILY_WORKFLOW_SERVER for compatible llama.cpp")?;
        let model = std::env::var_os("MEETILY_WORKFLOW_MODEL").map(PathBuf::from)
            .unwrap_or(super::summary_engine::models::get_model_path(&app_data, MODEL).map_err(|e| e.to_string())?);
        if !model.is_file() { return Err("Qwen3.5-4B Q4_K_M is not installed".into()); }
        macro_rules! source { ($name:literal) => {
            ($name, include_str!(concat!("../../resources/summary-workflow/", $name)))
        }; }
        for (name, source) in [source!("live.mjs"), source!("round.mjs"), source!("runtime.mjs"),
            source!("prompt.mjs"), source!("facts.mjs"), source!("text-facts.mjs"),
            source!("workflow-submissions.mjs"), source!("relevant-memory.mjs")] {
            std::fs::write(directory.join("runtime").join(name), source).map_err(|e| e.to_string())?;
        }
        // Release any idle built-in summary model before reserving this recording's model.
        super::summary_engine::client::force_shutdown_sidecar().await.map_err(|e| e.to_string())?;
        let mut memory = sysinfo::System::new();
        memory.refresh_memory();
        write(&directory.join("memory.json"), &json!({"available_bytes":memory.available_memory()}))?;
        let mut command = tokio::process::Command::new(node);
        command.arg(directory.join("runtime/live.mjs")).arg(&directory)
            .env("MEETILY_WORKFLOW_SERVER", server).env("MEETILY_WORKFLOW_MODEL", model)
            .stdin(Stdio::piped()).stdout(Stdio::null())
            .stderr(std::fs::File::create(directory.join("worker.stderr.log")).map_err(|e| e.to_string())?);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        alive.store(true, Ordering::SeqCst);
        SESSIONS.lock().unwrap().get_mut(job_id).unwrap()._stdin = child.stdin.take();
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
        write(&folder.join("summary-live.json"), &json!({"job_id":job_id,"workflow":"fixed-facts-v1",
            "run_directory":session.directory}))?;
    }
    Ok(())
}
pub fn status(job_id: &str) -> Option<Value> {
    SESSIONS.lock().unwrap().get(job_id).map(|session| {
        let value = read(&session.directory.join("state.json")).unwrap_or(json!({"status":"starting"}));
        json!({"status":value["status"],"completed_batches":value["completed_batches"].as_u64().unwrap_or(0),
            "queued_batches":value["queued_batches"].as_u64().unwrap_or(0),
            "failed_batches":value["failed_batches"].as_u64().unwrap_or(0), "error":value["error"]})
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
    Ok((value["workflow"] == "fixed-facts-v1").then_some(value))
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
        json!({"markdown":markdown,"workflow":"fixed-facts-v1","semantic_quality_verified":false}),
        value["completed_batches"].as_i64().unwrap_or(0),
        value["settled_seconds_after_stop"].as_f64().unwrap_or(0.0)).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn finalize_recording_summary<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>, state: tauri::State<'_, crate::state::AppState>, meeting_id: String,
) -> Result<bool, String> {
    let _start_guard = super::commands::SUMMARY_START_LOCK.lock().await;
    let pool = state.db_manager.pool().clone();
    let Some(manifest) = manifest(&pool, &meeting_id).await? else { return Ok(false) };
    let directory = PathBuf::from(manifest["run_directory"].as_str().ok_or("Missing workflow directory")?);
    let job_id = manifest["job_id"].as_str().ok_or("Missing workflow job ID")?.to_owned();
    if let Some(existing) = SummaryProcessesRepository::get_summary_data(&pool, &meeting_id).await.map_err(|e| e.to_string())? {
        if existing.status.eq_ignore_ascii_case("pending") || existing.status == "completed" { return Ok(true); }
    }
    let started = chrono::Utc::now();
    SummaryProcessesRepository::create_or_reset_process(&pool, &meeting_id, started).await.map_err(|e| e.to_string())?;
    let cancellation = super::service::SummaryService::register_cancellation_token(&meeting_id, started);
    tokio::spawn(async move {
        let result: Result<(), String> = async {
            let deadline = tokio::time::Instant::now()+Duration::from_secs(125);
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
        }
        super::service::SummaryService::cleanup_cancellation_token(&meeting_id, started);
    });
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
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
        let value = json!({"status":"ready","markdown":"## 行动\n- 小林提交周报。",
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
