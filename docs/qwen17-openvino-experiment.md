# Qwen3-1.7B 与 Iris Xe 验证

2026-09-28，在独立分支 `codex/meeting-section-summary` 上验证参考项目同系列的 1.7B 模型与 Intel 核显。日常入口和原生应用保持原状，ASR、VAD、Community-1 及纪要提示词未修改。本次追加模型身份传递和隔离的文本预检工具；不是正式 OpenVINO 后端集成。

## 环境与模型

- Windows 11，Intel i5-11300H、Iris Xe、8GB RAM；显卡驱动 32.0.101.5768。
- llama.cpp b10809 Vulkan 发行版，用同一二进制分别指定 CPU（`--device none -ngl 0`）和 Vulkan（`--device Vulkan0 -ngl 99`）。Vulkan 启动日志确认 29/29 层在 Iris Xe 上执行。
- [Qwen3-1.7B GGUF](https://huggingface.co/unsloth/Qwen3-1.7B-GGUF)，revision `d7f544eead698dbd1f15126ef60b45a1e1933222`，Q4_K_M 文件 1,107,409,472 bytes，SHA-256 `b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897`。
- [OpenVINO Qwen3-1.7B INT4](https://huggingface.co/OpenVINO/Qwen3-1.7B-int4-ov)，revision `6f32d81e9deebeca30bb5490a7176cf4fa8c79e3`。主权重 1,181,738,708 bytes，SHA-256 `2f15d719cab2e475444ff84d77d432ecf757e0ec5b93dc1b48710802f96ef34f`；所有 tokenizer、配置及 IR 文件也逐项校验。量化是 INT4_ASYM、ratio 0.8、group_size 128。
- 隔离 Python 3.12 环境：`openvino-genai==2026.4.0.0`、`openvino==2026.4.0`、`openvino_tokenizers==2026.4.0.0`、`psutil==7.2.2`。INT8 未下载、未测试。

## 两请求后端预检

从 full06 捕获一份会中笔记请求和一份主要讨论章节请求。提示词、非思考、温度 0.2、top_p 0.9、top_k 40、seed 42 保持一致，输出上限 1280/2048，输入加输出不超过 6144 token。CPU 两线程，各后端顺序运行，不并行加载模型，不包含 ASR/说话人负载。

| 后端 | 会中笔记 | 主要讨论 | 生成 token/s（两请求） | 可用内存最低 | 模型进程 RSS 峰值 | 全机 CPU 平均 |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| GGUF CPU | 45.078s | 182.359s | 11.38 / 7.86 | 2.863GiB | 1.778GiB | 27.62% |
| GGUF Vulkan | 55.000s | 149.437s | 9.29 / 8.46 | 2.612GiB | 2.099GiB | 13.41% |
| OpenVINO CPU | 42.172s | 117.766s | 11.79 / 11.34 | 1.992GiB | 2.871GiB | 35.85% |
| OpenVINO GPU | 62.609s | 156.344s | 6.95 / 6.89 | 2.138GiB | 3.073GiB | 19.41% |

八次响应均正常 stop，无长度截断。OpenVINO 显式指定 GPU 完成实际模型推理，没有 AUTO 或 CPU 兜底。GPU 首 token 1.858/2.986 秒，CPU 10.623/14.635 秒；核显处理输入更快，但持续生成更慢，本次两个请求总耗时 CPU 最短。加载编译 CPU 2.359 秒、GPU 19.609 秒另外记录，不计入表中请求耗时；安装后的首次设备枚举额外耗时未包括在内。

每组只测一次，输出长度不同；GGUF 与 OpenVINO 的量化和采样实现也不同，因此不能把全部差异归因于后端或宣称稳定加速比例。RSS 含映射/共享页，不能视为独占物理内存；核显也使用系统 RAM。以上测试不代表与 ASR/Community-1 同时运行时的内存与积压表现。GGUF 测试期间还有串行安排的 IR 文件下载。

质量初筛中，OpenVINO CPU 把“房子到期、是否续租待讨论”写成“已续租”；GPU 有条件混淆与待办强化；GGUF 两边把未说完的人流量讨论补成具体住宿优化待办。技术 stop 不代表质量通过。主要讨论请求使用旧 4B 笔记，只用于局部对照，不能代替从完整转写重做所有笔记的质量检查。

## 完整文本预检工具

`scripts/validate-openvino-summary-replay.mjs` 复用生产 `runLive` 与章节逻辑，使用 `scripts/openvino-summary-probe.py` 提供仅绑定本机的模板、tokenize 和生成接口。所有实际生成都指定 Qwen3-1.7B；模型 id 进入持久化状态和请求检查点，避免跨模型复用缓存。默认模型工厂与原 4B 行为不变。

在已安装上述依赖的 Windows 隔离环境中运行：

```text
node scripts/validate-openvino-summary-replay.mjs <captured-input.json> <fresh-output-directory> <venv-python.exe> <OpenVINO-model-directory> CPU
```

最后一个参数也可以是 GPU。运行前确认没有其他总结模型；输出目录必须是新目录。输入采用已保存的完整说话人批次快照，所有文本一次到达，完成会中笔记后再触发尾部和逐章汇总。脚本保存原始请求、响应、最终 Markdown、资源采样和模型配置；每次调用仍受 600 秒期限与实际 token 预算限制。Windows venv 有子解释器，结束时只释放本次拥有的进程树。

该预检排除原速输入、ASR、VAD、说话人分离和真实数据库保存。其最大排队量主要来自一次投递全文，不能用来报告实时积压；其最终整理耗时也不能充当应用停止到落库时间。

Mac 与 Windows 各 15 项工作流测试通过，新增模型身份与跨模型缓存隔离测试。目标 Windows 短文本预检 `openvino-cpu-smoke-01` 完整生成与资源释放通过，26.782 秒；没有用这份短测推断整场质量。

## 2026-09-28 完整文本预检结果

`openvino-cpu-fulltext-01` 完成，控制器exit0，自有Python模型进程树已退出。1137段ASR的原文/id/时间、63批标签和来源均逐项核对；16份笔记的来源字符区间连续覆盖13656字符，所有章节分组输入与笔记材料逐字覆盖。22次生成全部stop，最终6004字符。**技术流程通过，内容质量不通过，纯摘要最终整理仍超过120秒。** 因此本轮保留为实验，不推进该候选的原生整场录制或正式入口。

| 指标 | 实测 |
| --- | ---: |
| 完整纯摘要总时间 | 888.753秒（14分48.753秒） |
| 模拟会中15份笔记 | 546.547秒 |
| 1份尾文笔记 | 7.471秒 |
| 五章6次整理调用 | 330.750秒 |
| 模拟停止到全部完成 | 338.807秒（5分38.807秒） |
| CPU平均 / P95 / 最高 | 27.74% / 30.4% / 42.9% |
| 系统可用内存最低 | 2.162GiB |
| 模型进程RSS / 私有提交峰值 | 2.881 / 2.218GiB |

这不是原速积压或停止到数据库的实测。原4B full06虽然提供了同一份完整转写，但本轮一次到达全文，笔记边界、数量和内容不同，也没有ASR负载，不能将两轮最终耗时比例视为已验证的真实应用改善。

质量复核定位到明确错误：

- 第一份笔记把到期且待讨论续租改为已续租，最终结论继续保留。
- ASR的不确定“8山”被补成800元，参考是罚三百；不能仅将此归因于ASR。
- 末尾明确的撰写并提交报告要求已进入笔记输入，却在笔记与最终纪要中遗漏。
- 26条待办包含多项从外部厂商见闻推导出的核实/调查任务；相关原文没有交办。
- 尾部“待确认”匿名标签加结束语被解释成待确认议题，又被写成整场没有达成决策；还出现重复碎句。这显示第一层笔记已有错误，第二层仅整理笔记无法恢复被遗漏原文。

主要主题有覆盖，但不能抵消错状态、猜数字和漏行动。保持原提示词完成本轮对照，未根据参考答案改写模型输出。没有通过小模型或GPU消除准确性边界，不切换日常默认入口。

本地原始证据在 `artifacts/offline-development/qwen17-igpu-20260928/`，未将私有转写或纪要加入Git。证据包SHA-256 `abf3fd74e5818243e80f6ef0a3a4351bfc03287d189ff1ce9f25edffd9b2e4dd`；`fulltext-evidence/openvino-cpu-fulltext-01/minutes-raw.md` 与状态正文逐字一致，SHA-256 `2a7e8d1e77b20c47575107cd6ed33bd098ec8df877492b6cf98eb3ddaf2a97a8`。另有 `fulltext-metrics.json`、`fulltext-chapter-coverage.json`、`QUALITY_REVIEW.md` 与原始请求响应，可复核性能、来源覆盖及错误发生阶段。

用户要求改为当前会话实时汇报后，跟进自动化已暂停，不自动恢复。原goal保持暂停。原日常启动脚本及启动器SHA与实验前一致，未创建新的Windows计划任务。
