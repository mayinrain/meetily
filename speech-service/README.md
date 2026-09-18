# Meetily 离线语音服务

本目录包含与 Meetily 客户端配套的 SenseVoice ASR 和 Pyannote Community-1 处理逻辑。从原工作区的独立服务纳入，运行代码保持原样；客户端仍通过 `http://127.0.0.1:8765` 调用，不需要原工作区或其绝对路径。

当前实现是：Meetily VAD 产生完整转写段 → SenseVoice 转写；连续 PCM 同时交给 Community-1 积累特征 → 停止录制后全场聚类 → exclusive 说话人区间绑定原转写段。原始重叠说话人区间也保留。会中分段发布 Community-1 标签并生成分段摘要，以及 Qwen 核显实验，均不属于本次纳入范围。

## 源码和接口

| 文件 | 作用 |
| --- | --- |
| `server.py`、`core.py`、`protocol.py` | 回环 HTTP 服务、SenseVoice 模型、转写和日志 |
| `live_speaker_streams.py` | 每场录音的独立子进程、连续 PCM 输入、取消与状态 |
| `process_community_speakers.py` | Community-1 加载、特征计算、最终聚类与结果落盘 |
| `community1_feature_stream.py` | 保留模型滑窗重叠，累计分割和声纹特征 |
| `community1_shared_frames.py` | 同窗口复用 WeSpeaker 卷积结果，保留各说话人的掩码和池化 |
| `community_resample.py` | 连续 48→16 kHz 重采样及尾部排空 |
| `speaker_batches.py`、`speaker_jobs.py` | 完整转写段边界、段级归属、保存音频的重试任务 |
| `community_config.py` | Community-1 独立环境、模型和线程配置 |
| `monitor.py` | 独立资源采样工具 |

`process_speakers.py`、`process_live_speakers.py` 和 `nemo_stream.py` 保留原服务的 Sortformer 兼容路径与共用函数，避免为收录源码改写已经验证的运行逻辑。按下方 Community-1 参数启动时，不需要下载 Sortformer 权重或 native 库。

客户端接入位于 `frontend/src-tauri/src/live_speakers.rs` 和 `meeting_speakers.rs`。

| 接口 | 用途 |
| --- | --- |
| `GET /health` | 服务、ASR 加载状态和说话人后端 |
| `POST /v1/models/load`、`/unload` | 由客户端管理 ASR 模型生命周期 |
| `POST /v1/segment` | 已经 VAD 分段的 16 kHz 单声道 float32 PCM 转写 |
| `POST /v1/speaker-streams` | 开启一场 16/48 kHz 说话人流 |
| `POST /v1/speaker-streams/{id}/audio?offset=...` | 每次最多 1 秒 float32 PCM，offset 为连续采样点偏移 |
| `POST /v1/speaker-streams/{id}/segments` | 追加完整转写段，不改变已提交的前缀 |
| `GET /v1/speaker-streams/{id}` | 读取状态与结果 |
| `POST /v1/speaker-streams/{id}/finish`、`/cancel` | 排空、聚类，或取消 |
| `POST /v1/speakers` | 对已保存的录音重新分析；GET `/v1/speakers/{id}` 查询，POST 其 `/cancel` 取消 |

流式音频与 ASR 转写段是两条独立输入，不能只发送 VAD 检出的音频，否则会破坏连续时间轴。保存文件重试需要重新计算整场特征，不能套用正常录制的短收尾耗时。

## 环境准备

下列命令在 **Windows PowerShell、仓库根目录** 执行，使用 Python 3.12 x64。应用构建要求见 [BUILDING.md](../docs/BUILDING.md)。此处仅准备服务，不会改动现有 Meetily 安装或注册后台启动任务。

ASR 与 Pyannote 使用两个独立环境；不要将两份依赖装入同一个环境。

```powershell
py -3.12 -m venv speech-service/.venv
& .\speech-service\.venv\Scripts\python.exe -m pip install -r speech-service/requirements.txt
& .\speech-service\.venv\Scripts\python.exe -m pip check

py -3.12 -m venv speech-service/.venv-community
& .\speech-service\.venv-community\Scripts\python.exe -m pip install torch==2.9.1 torchaudio==2.9.1 --index-url https://download.pytorch.org/whl/cpu
& .\speech-service\.venv-community\Scripts\python.exe -m pip install -r speech-service/requirements-community1.txt
& .\speech-service\.venv-community\Scripts\python.exe -m pip check
```

Community-1 固定 `pyannote.audio==4.0.7`；帧复用代码使用了该版本的内部接口，升级模型或库后须重新跑数值等价验证。两份 requirements 固定直接依赖版本，并非所有传递依赖的完整锁文件。

FFmpeg 命令行用于读取 AAC/MP4 等保存录音：将 `ffmpeg.exe` 放到仓库的 `tools/ffmpeg.exe`，或加入 PATH，也可以设置 `MEETING_FFMPEG` 为其绝对路径。无需将二进制提交到 Git。

## 模型准备

模型下载在联网准备阶段完成，推理使用本地目录。权重、令牌和录音都不纳入 Git。

```text
shared/models/
  silero_vad.onnx
  sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/
    model.int8.onnx
    tokens.txt
  pyannote-community-1/
    config.yaml
    segmentation/pytorch_model.bin
    embedding/pytorch_model.bin
    plda/plda.npz
    plda/xvec_transform.npz
```

SenseVoice 使用 sherpa-onnx 官方发布的 INT8 版本，目录名应保持如上。[官方下载说明](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html)。准备命令：

```powershell
New-Item -ItemType Directory -Force shared/models | Out-Null
curl.exe --fail --location https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2 --output shared/models/sensevoice.tar.bz2
tar.exe -xjf shared/models/sensevoice.tar.bz2 -C shared/models
curl.exe --fail --location https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx --output shared/models/silero_vad.onnx
```

Community-1 使用官方仓库 [`pyannote/speaker-diarization-community-1`](https://huggingface.co/pyannote/speaker-diarization-community-1)，固定 revision `3533c8cf8e369892e6b79ff1bf80f7b0286a54ee`，模型许可为 CC-BY-4.0。先在模型页面接受访问条件，再通过本机交互登录下载；不把令牌写入命令或仓库。

```powershell
& .\speech-service\.venv-community\Scripts\python.exe -c "from huggingface_hub import login; login()"
& .\speech-service\.venv-community\Scripts\python.exe -c "from huggingface_hub import snapshot_download; snapshot_download('pyannote/speaker-diarization-community-1', revision='3533c8cf8e369892e6b79ff1bf80f7b0286a54ee', local_dir='shared/models/pyannote-community-1')"
```

已验证模型的文件大小和 SHA-256 见 [community1-model-manifest.json](community1-model-manifest.json)。可在 PowerShell 中逐项检查：

```powershell
$manifest = Get-Content speech-service/community1-model-manifest.json -Raw | ConvertFrom-Json
foreach ($entry in $manifest.files) {
    $file = Join-Path shared/models/pyannote-community-1 $entry.path
    if ((Get-Item $file).Length -ne $entry.size -or (Get-FileHash $file -Algorithm SHA256).Hash.ToLower() -ne $entry.sha256) {
        throw "Model checksum mismatch: $($entry.path)"
    }
}
```

## 启动和连接客户端

在仓库根目录启动服务，使用绝对路径将独立 Pyannote 环境交给 worker：

```powershell
$communityPython = (Resolve-Path speech-service/.venv-community/Scripts/python.exe).Path
$communityModel = (Resolve-Path shared/models/pyannote-community-1).Path
$env:HF_HUB_OFFLINE = '1'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
$env:PYANNOTE_METRICS_ENABLED = '0'
& .\speech-service\.venv\Scripts\python.exe -u speech-service/server.py `
    --models shared/models --runs runs --threads 2 `
    --community-python $communityPython --community-model $communityModel
```

服务固定绑定 `127.0.0.1`，默认端口为 `8765`。Meetily 当前使用这个固定地址，不要仅修改服务端口。若此端口已经被已部署的语音服务占用，请继续使用已有服务，或退出自己启动的旧服务后再启动，避免影响正在录制的会议。

另开终端检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8765/health
```

空闲时应有 `status=not_ready`、`busy=false`、`speaker_model=pyannote-community-1`、`speaker_stream_available=true`。`not_ready` 表示 ASR 权重尚未加载，是正常的省内存状态，不代表服务启动失败。客户端开始录制时会加载它；结束后会释放。

启动由本分支构建的 Meetily，在转写设置中选择 SenseVoice。首次录制应确认实际麦克风/系统音频设备，不需要虚拟声卡。开发模式可在 `frontend` 下按构建文档执行 `pnpm install`、`pnpm run tauri:dev`；8GB 目标机宜运行预先构建好的程序。

按 Ctrl+C 停止当前终端启动的服务；自动化调用可传 `--stop-file <一个尚不存在的文件路径>`，创建该文件会请求正常退出。`runs/` 保存运行配置、事件、资源采样和子进程日志，勿把这些可能含会议内容的文件纳入源码提交。

本目录仅补齐语音链路。总结仍由 Meetily 的本地 llama-helper 负责，其模型下载与配置独立；不包含本地测试机器的已编译程序、打包时使用的第三方构建缓存或完整安装器。

## 验证

不需要下载模型即可运行协议、任务生命周期、重采样、归属和资源采样测试：

```powershell
& .\speech-service\.venv\Scripts\python.exe -m pytest speech-service -q
```

`test_service.py` 的真实 ASR 测试在缺少模型时跳过。执行真实测试前，除上述模型外，准备 `shared/audio/meeting-speech-16k.wav`，或用 `MEETING_TEST_AUDIO` 指定自己的 16 kHz 测试音频；涉及尾部发言的测试需要含相应语音的样本。测试临时目录与正常服务的 `runs/` 独立。

真实 Community-1 特征等价验证需要本地模型和至少 20 秒的 16 kHz 单声道 PCM16 WAV：

```powershell
New-Item -ItemType Directory -Force runs | Out-Null
& .\speech-service\.venv-community\Scripts\python.exe speech-service/verify_community1_feature_stream.py `
    --model shared/models/pyannote-community-1 `
    --audio shared/audio/meeting-speech-16k.wav --output runs/feature-verification.json
```

该检查比较连续输入与整段处理的分割、声纹以及普通/exclusive 输出；不等同于真实录制并发或多人准确度验收。`verify_community1_shared_frames.py` 另提供帧复用与原版声纹的数值对照，需要命令帮助列明的音频目录。

此前部署验证范围：66 分钟 app-16 实录提供性能基线；app-17 修复停止时 JSON 尾句漏写，并通过 30 秒尾音、20 秒短会议回归。app-17 未重跑整小时；多人准确度、人工回听和自动纪要质量尚未全部验收。本次纳入源码不改变这些结论。
