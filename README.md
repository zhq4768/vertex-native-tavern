# Vertex 原生正文传输 0.1.9

TauriTavern 的本地扩展，用于通过完整服务账号 JSON 认证的原生 Google Vertex AI 连接。服务账号在酒馆的 Vertex 面板配置，由 TauriTavern 后台换取 OAuth 令牌、选择请求端点并访问 Google。扩展在 WebView 中处理正文传输和回复流。

## 本地安装

1. 关闭 TauriTavern。
2. 将完整的 `vertex-native-tavern` 目录放进该应用数据目录下的 `default-user/extensions/`。确认扩展目录下直接包含 `manifest.json`。
3. 启动 TauriTavern。到「API 连接 → Google Vertex AI」，打开「Vertex 原生正文传输」，勾选启用，并打开酒馆的「流式传输」。一次只启用一个改写 Vertex 请求的抗截断扩展。
4. 可选填写模型 ID，以及截停标签、完整出现次数和豁免标签。比如 `UpdateVariable` 和 `1` 会保留第一对完整标签，结束标签后的内容会舍弃。需要后续栏目时留空关闭截停。

使用 Git 安装时，在 TauriTavern 的「扩展程序 → 安装扩展」填写 [本仓库地址](https://github.com/zhq4768/vertex-native-tavern)，分支留空。已有 Git 安装可从扩展管理器更新，随后重载酒馆。

从扩展管理器禁用本扩展并重启，可恢复 TauriTavern 的原生路径。

## 兼容范围

- Google 官方 Vertex 连接、Gemini 文本、单候选、真流式。扩展默认关闭，保留原生思考事件、上游结束码和可用的用量帧。
- 使用客户端工具、内置工具或联网搜索时，Canary 原生 Vertex 通道负责组装并保留工具续轮。扩展会原样转发对应的请求，包括历史消息携带 Gemini 原生工具事件的回合。其他提供商、中转地址、结构化响应或生图也按原路径发送。兼容的正文传输请求可使用 JSON 附加参数。
- 最大回复超过 65,536 tokens 时，原生连接每段最多请求 32,768 tokens，最多五段。若一段收到长度或函数格式中断，且已经输出正文并剩有预算，扩展保留原始消息，将已输出正文作为上一条助手回复，再用一条短指令要求 `vertex_deliver_text` 在 `content` 中交付接下来的正文。每段合并进同一条酒馆回复，去除可确认的重复开头或接缝重叠，并交付上一段结束标志之后的用量帧。
- 首段和续写段在输出内容前遇到 429 或 503 时，可以重发同一段。每段独立计数，0 次关闭额外重试。默认首次等 10 秒，后续间隔逐步翻倍并加入少量随机延迟。支持 HTTP 和流内错误，以及 `Retry-After` 或 `RetryInfo`。如果上游要求等待超过 300 秒，将直接报告错误。收到本段内容后发生错误时，保留已交付内容并停止重试。
- Canary 的 `/llmlog` 打开请求查看器，可在实际生成后查看 Vertex 请求及响应。提示词管理器的「预览请求」在扩展改写前组装，适合检查酒馆预设。
- 上游正常完成、安全结束或达到截停标签时结束当前回复。取消当前回复也会取消后续请求。遇到意外断流会显示错误并保留已收到的正文。
- 截停默认立即断开。可勾选「截停后等 Google 结束并回报用量」，正文仍在标签处立即停显，扩展继续读取同一条流的 `usageMetadata`。标签后的上游生成仍可能计费。用量缺失时面板会提示，扩展不会估算补齐。
- 0.1.8 支持读取流关闭前未加空行的最后一帧。已收到的结束状态和用量仍会传给酒馆，缺失结束标记的断流继续报错。
- 请求期限由 TauriTavern 原生连接和 Google 端点决定。扩展沿用酒馆的取消信号，原生请求不经过 8050 控制台。
- 在使用正文传输工具的回合，聊天历史采用还原后的完整正文。扩展会丢弃本轮的 Gemini 单段快照，以免下一个聊天回合只引用末段或重放正文工具。
- 原生连接通过 TauriTavern 的 Vertex `v1` 路径。分段续写用新的请求和完整正文衔接。每段会重新提交上下文，可能增加用量。

## 请求诊断

开启扩展后，在「API 连接 → Google Vertex AI → Vertex 原生正文传输 → 最近请求」查看或复制诊断。面板保留本次打开酒馆期间最近 8 条 Vertex 请求，显示是否走原生直通、各段 HTTP 状态、流内 429/503、实际重试等待、首段正文到达时间、结束原因和用量帧是否到达。直通请求的详情可在 Canary `/llmlog` 查阅。

诊断只记录状态码、计数和时序等字段。凭据、请求地址、提示词、正文和上游报错原文均留在请求本身。`http` 记录 TauriTavern 返回给扩展的 HTTP 状态，`upstream-error` 在可识别时记录流里的 Google 错误码。

## 与参考项目的差异

| 功能 | 本扩展的处理 |
| --- | --- |
| 请求诊断、标签截停后的用量 | 适配到 TauriTavern WebView，使用同一条原生回复流。 |
| Standard 的 429 备用区域 | 参考项目由独立网关或普通 SillyTavern 服务端插件切换端点。TauriTavern 这条路径由宿主选区，扩展在同一区域重试。 |
| `v1beta1` 令牌续接、账号池、Express、Docker | 属于网关或服务端能力，本扩展使用原生 `v1` 正文分段续写。 |
| 客户端工具、Google Search、预设正文工具 | 普通工具和搜索交由 Canary 原生处理。自定义正文工具及 `soliumbra_reply` 的多字段传输需要单独适配预设。 |
| 非流式交付、Unicode/GBK 转码、文字转图 | 参考项目的可选功能。本扩展专注于使用原始输入的真流式正文。 |

对照版本为 [酒馆插件 0.20.0 的请求诊断](https://github.com/ken050210/vertex-streaming-anti-truncation/releases/tag/sillytavern-v0.20.0) 和 [网关 0.25.0 的 Standard 区域切换](https://github.com/ken050210/vertex-streaming-anti-truncation/releases/tag/gateway-v0.25.0)。

## 验收

使用 Node.js 20 或更新版本执行 `node --test transport.test.mjs`。测试使用模拟 Vertex 流和本地 fetch 替身。正式使用前可先在隔离的测试项目，用少量正常请求验证当前 TauriTavern 和模型的实际兼容性。

功能设计参考 [ken050210/vertex-streaming-anti-truncation](https://github.com/ken050210/vertex-streaming-anti-truncation) 的公开文档。本项目独立实现。
