# 实时会议纪要集成

本分支 `codex/meeting-realtime-summary` 将录音、实时转写、Community-1 说话人批次与固定事实摘要工作流接入同一应用。摘要模型为本地 Qwen3.5-4B Q4_K_M，非思考模式。输出为中文草稿：讨论、决定、行动、待确认。正文不显示 F 编号、原文段号或引用。

这是产品集成分支；此前独立实验分支 `codex/meeting-summary-workflow` 保留。模型仍可能遗漏要点、误写事实，或在修订负责人时丢失未变的期限，需要人工核对。集成通过不代表内容质量已经验收。

## 实际流程

1. Meetily 继续录音、保存 AAC，并按自然语音段调用 SenseVoice；原混音 PCM 同时送入 Community-1。
2. Community-1 连续积累分割和声纹特征。自然段累计跨度达到约 60 秒，在完整段末成批，再保留约 5 秒后续上下文。后台基于当前整场特征聚类，不重新提取过去的声音特征。
3. 新聚类通过历史发言时间重合匹配已有匿名编号，已经发布的批次冻结；冲突及跨说话人转写段保留“待核对”，不会编造逐字边界。近期音频不必包含全部说话人。
4. 完整、带说话人的批次进入串行摘要队列。每批一次模型调用，召回最多四条相关旧事项与前两段原文；新增由程序编号，只有显式修订才能修改本批提供的旧条目。解析、截止中止或截断失败整批不保存，后续批次仍可处理，失败计入未提交积压。
5. 停止录制后，提交尾音、最终聚类和不足一批的文字，排空摘要队列。报告直接排版累计事项，不额外调用模型重写全文。校验已保存的原始转写文本及时间后写入 Meetily 的摘要数据库，沿用现有查看、编辑、重开和导出入口。

会后 120 秒是工作流的收尾期限，从录音向说话人任务发出结束通知时计算，包含等待最后说话人批次与摘要。超时保留部分结果并显示失败，不能把超时当作成功。该计时不包括此前录音停止动作中的 AAC/ASR 收尾；完整桌面停止总时延需要另外实测。

## 使用与依赖

目标环境是已经准备好的 Windows 离线安装。选择 SenseVoice 作为转写模型，摘要选择 **Built-in AI / Qwen3.5 4B**。其它摘要模型继续使用原手动生成流程，不自动开启这套增量工作流。

新增运行依赖为 Node.js 22.23.1 和兼容的 llama.cpp **b10809** `llama-server.exe`。Node 工作流不安装 npm 包；解析、检索和提示词从已验证实验提取为共享模块，构建时嵌入应用。每场会议仅有一个工作流进程和一个按需启动的模型服务，监听随机本机端口，CPU 2 线程、6144 上下文、最多 650 输出 token。结束、取消或父应用断开后释放自建模型服务。

语音服务依赖见 `speech-service/requirements.txt` 和 `requirements-community1.txt`，两套 Python 环境保持独立。Community-1 和 ASR 的模型文件沿用已安装版本。

构建应用后，在仓库内使用准备好的服务 Python 执行：

```powershell
C:\Users\admin\meeting-offline\speech-service\.venv\Scripts\python.exe scripts\start-realtime-offline.py --app C:\path\to\meetily.exe --check
C:\Users\admin\meeting-offline\speech-service\.venv\Scripts\python.exe scripts\start-realtime-offline.py --app C:\path\to\meetily.exe
```

`--root` 可指定准备好的安装目录，默认 `%USERPROFILE%\meeting-offline`。默认寻找：

- `tools/node-v22.23.1-win-x64/node.exe`
- `tools/llama-b10809/llama-server.exe`
- `shared/models/Qwen3.5-4B-Q4_K_M.gguf`
- `tools/community1-bench-01/.venv/Scripts/python.exe`
- `shared/models/pyannote-community-1`

启动器会设置 `MEETILY_WORKFLOW_NODE`、`MEETILY_WORKFLOW_SERVER`、`MEETILY_WORKFLOW_MODEL`，检查语音服务支持会中批次，并启动本分支语音源码。已有其它 Meetily 实例时要求先退出；不复用旧应用，也不停止外部启动器拥有的服务。

直接启动 EXE 也可以，但必须配置这些环境变量。缺少运行时或模型会显示分段摘要失败，录音和转写继续。可用内存低于 768 MiB 时中止摘要；不同时加载多个录音摘要模型。上一场仍在收尾时，新录音保留录音/ASR，但会明确显示其摘要未启动。

## 保存、取消和重试

`%APPDATA%\com.meetily.ai\recording-summaries\<run>` 保存当前 `state.json`、完整累计输入、实际模型请求和响应、事实修改前后状态与资源最低值。会议录音目录的 `summary-live.json` 指向该运行记录。内部记录不等同于逐条事实依据，不会显示在纪要正文里。

失败不会回滚录音或转写，也不会把部分纪要标成完整成功。部分草稿在 `state.json` 的 `markdown` 中可取回。进程崩溃后不自动重复模型调用；完整成功的结果可再次落库，未完成任务需要用户显式重新生成。现有“重新生成”会使用可编辑转写和原模板流程；不是断点续跑。人工修改了转写后，旧缓存不会自动覆盖新文本。

## 回归与真实模型回放

```sh
cd frontend
node --test tests/summary-workflow.test.mjs
bun test tests/hooks tests/lib
./node_modules/.bin/tsc --noEmit
cd ..
cargo test -p meetily --lib summary:: --no-default-features
python -m pytest -q speech-service
cd prototypes/meeting-summary-workflow
bun run test
```

`scripts/validate-realtime-workflow.py --help` 提供原速真实音频接口回放。它同时运行真实 ASR、VAD、Community-1 和摘要模型，不使用预先计算的文字或说话人标签。输出包含批次来源一致性、实际模型调用、未提交积压、会后时延、进程树 RSS 与系统可用内存。此测试不包含麦克风、AAC、桌面 UI 和 SQLite；数据库落库由原生回归单独验证，目标机整应用验收需另测。

本轮验证结果见 [集成验证记录](realtime-meeting-validation.md)。
