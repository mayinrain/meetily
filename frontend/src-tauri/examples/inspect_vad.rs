//! Replay a short raw mono f32le fixture through Meetily's actual live VAD.
//! Usage: inspect_vad <fixture.f32> <sample-rate> [redemption-ms]
use app_lib::audio::vad::ContinuousVadProcessor;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let rate: u32 = args.get(2).expect("sample rate").parse()?;
    let redemption = args.get(3).map(|v| v.parse()).transpose()?.unwrap_or(500);
    let bytes = std::fs::read(args.get(1).expect("fixture path"))?;
    anyhow::ensure!(bytes.len() % 4 == 0, "f32le fixture length must be divisible by four");
    let samples: Vec<f32> = bytes.chunks_exact(4)
        .map(|v| f32::from_le_bytes(v.try_into().unwrap())).collect();
    let mut vad = ContinuousVadProcessor::new(rate, redemption)?;
    let mut segments = Vec::new();
    for chunk in samples.chunks(rate as usize * 600 / 1000) {
        segments.extend(vad.process_audio(chunk)?);
    }
    segments.extend(vad.flush()?);
    let rows: Vec<_> = segments.iter().map(|segment| serde_json::json!({
        "start": segment.start_timestamp_ms / 1000.0,
        "end": segment.end_timestamp_ms / 1000.0,
        "sample_count": segment.samples.len()
    })).collect();
    println!("{}", serde_json::to_string_pretty(&rows)?);
    Ok(())
}
