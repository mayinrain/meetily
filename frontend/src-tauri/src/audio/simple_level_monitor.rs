use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait};
use tauri::{AppHandle, Runtime};
use tokio::sync::{oneshot, Mutex};

// CPAL streams stay on their owning thread. Commands serialize start/stop and
// join that thread before recording can acquire the microphone.
struct Worker {
    stop: oneshot::Sender<()>,
    thread: std::thread::JoinHandle<()>,
}
static WORKER: Mutex<Option<Worker>> = Mutex::const_new(None);

async fn stop_worker(worker: &mut Option<Worker>) -> Result<()> {
    if let Some(worker) = worker.take() {
        let _ = worker.stop.send(());
        tokio::task::spawn_blocking(move || worker.thread.join()).await?
            .map_err(|_| anyhow!("Audio level worker stopped unexpectedly"))?;
    }
    Ok(())
}

pub async fn start_monitoring<R: Runtime>(app: AppHandle<R>, mut device_names: Vec<String>) -> Result<()> {
    let mut worker = WORKER.lock().await;
    stop_worker(&mut worker).await?;
    let (ready_tx, ready_rx) = oneshot::channel();
    let (stop, stopped) = oneshot::channel();
    let thread = std::thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(runtime) => runtime,
            Err(error) => { let _ = ready_tx.send(Err(error.to_string())); return; }
        };
        runtime.block_on(async move {
            let mut monitor = super::level_monitor::AudioLevelMonitor::new();
            let result: Result<()> = async {
                if device_names.is_empty() {
                    let device = cpal::default_host().default_input_device()
                        .ok_or_else(|| anyhow!("Default microphone unavailable"))?;
                    device_names.push(device.name()?);
                }
                monitor.start_monitoring(app, device_names).await
            }.await;
            let started = result.is_ok();
            let _ = ready_tx.send(result.map_err(|error| error.to_string()));
            if started { let _ = stopped.await; }
            let _ = monitor.stop_monitoring().await;
        });
    });
    *worker = Some(Worker { stop, thread });
    match ready_rx.await? {
        Ok(()) => Ok(()),
        Err(error) => { stop_worker(&mut worker).await?; Err(anyhow!(error)) }
    }
}

pub async fn stop_monitoring() -> Result<()> {
    stop_worker(&mut *WORKER.lock().await).await
}

pub fn is_monitoring() -> bool {
    super::level_monitor::is_monitoring()
}
