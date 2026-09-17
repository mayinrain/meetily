use super::ffmpeg::find_ffmpeg_path; // Correct path to encode module
use super::AudioDevice;
use std::io::Write;
use std::sync::Arc;
use std::{
    path::PathBuf,
    process::{Command, Stdio},
};
use tracing::{debug, error};

/// Encode continuously while lossless checkpoints remain available for recovery.
pub(super) struct StreamingAudioEncoder {
    child: std::process::Child,
    temporary: PathBuf,
}

impl StreamingAudioEncoder {
    pub fn new(folder: &std::path::Path, sample_rate: u32) -> anyhow::Result<Self> {
        let temporary = folder.join("audio.incomplete.mp4");
        let log = std::fs::File::create(folder.join("audio-encoder.log"))?;
        let mut command = Command::new(find_ffmpeg_path().ok_or_else(|| anyhow::anyhow!("FFmpeg not found"))?);
        command.args(["-nostdin", "-hide_banner", "-loglevel", "warning", "-f", "f32le", "-ar",
            &sample_rate.to_string(), "-ac", "1", "-i", "pipe:0", "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart", "-y"])
            .arg(&temporary).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::from(log));
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        Ok(Self { child: command.spawn()?, temporary })
    }

    pub fn write(&mut self, samples: &[f32]) -> anyhow::Result<()> {
        self.child.stdin.as_mut().ok_or_else(|| anyhow::anyhow!("Audio encoder input closed"))?
            .write_all(bytemuck::cast_slice(samples))?;
        Ok(())
    }

    pub fn finish(mut self, output: &std::path::Path) -> anyhow::Result<()> {
        drop(self.child.stdin.take());
        let status = self.child.wait()?;
        if !status.success() {
            return Err(anyhow::anyhow!("Live AAC encoder exited {status}; see audio-encoder.log"));
        }
        std::fs::OpenOptions::new().write(true).open(&self.temporary)?.sync_all()?;
        std::fs::rename(&self.temporary, output)?;
        Ok(())
    }
}

impl Drop for StreamingAudioEncoder {
    fn drop(&mut self) {
        // Only this recording's encoder is owned here. Checkpoints survive failure.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct AudioInput {
    pub data: Arc<Vec<f32>>,
    pub sample_rate: u32,
    pub channels: u16,
    pub device: Arc<AudioDevice>,
}

pub fn encode_single_audio(
    data: &[u8],
    sample_rate: u32,
    channels: u16,
    output_path: &PathBuf,
) -> anyhow::Result<()> {
    encode_audio(data, sample_rate, channels, output_path, false)
}

/// Preserve every PCM sample between checkpoints; encode AAC once at finalization.
pub(super) fn encode_audio_checkpoint(
    data: &[u8],
    sample_rate: u32,
    channels: u16,
    output_path: &PathBuf,
) -> anyhow::Result<()> {
    encode_audio(data, sample_rate, channels, output_path, true)
}

fn encode_audio(
    data: &[u8],
    sample_rate: u32,
    channels: u16,
    output_path: &PathBuf,
    checkpoint: bool,
) -> anyhow::Result<()> {
    debug!("Starting FFmpeg process for {} bytes of audio data", data.len());

    if data.is_empty() {
        return Err(anyhow::anyhow!("No audio data provided for encoding"));
    }

    let ffmpeg_path = find_ffmpeg_path().ok_or_else(|| {
        anyhow::anyhow!("FFmpeg not found. Please install FFmpeg to save recordings.")
    })?;

    debug!("Using FFmpeg at: {:?}", ffmpeg_path);

    let mut command = Command::new(ffmpeg_path);
    command
        .args([
            "-f",
            "f32le",
            "-ar",
            &sample_rate.to_string(),
            "-ac",
            &channels.to_string(),
            "-i",
            "pipe:0",
        ]);
    if checkpoint {
        command.args(["-c:a", "pcm_f32le", "-f", "wav"]);
    } else {
        command.args([
            "-c:a",
            "aac",
            "-b:a",
            "192k", // Increased from 64k for better audio quality (especially for speech)
            "-profile:a",
            "aac_low", // Use AAC-LC profile for better compatibility
            "-movflags",
            "+faststart", // Optimize for web streaming
            "-f",
            "mp4",
        ]);
    }
    command
        .arg(output_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Hide console window on Windows to prevent CMD popup during recording
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    debug!("FFmpeg command: {:?}", command);

    #[allow(clippy::zombie_processes)]
    let mut ffmpeg = command.spawn().expect("Failed to spawn FFmpeg process");
    debug!("FFmpeg process spawned");
    let mut stdin = ffmpeg.stdin.take().expect("Failed to open stdin");

    stdin.write_all(data)?;

    debug!("Dropping stdin");
    drop(stdin);
    debug!("Waiting for FFmpeg process to exit");
    let output = ffmpeg.wait_with_output().unwrap();
    let status = output.status;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    debug!("FFmpeg process exited with status: {}", status);
    debug!("FFmpeg stdout: {}", stdout);
    debug!("FFmpeg stderr: {}", stderr);

    if !status.success() {
        error!("FFmpeg process failed with status: {}", status);
        error!("FFmpeg stderr: {}", stderr);
        return Err(anyhow::anyhow!(
            "FFmpeg process failed with status: {}",
            status
        ));
    }

    Ok(())
}
