# Vertex 原生正文传输 0.1.6

TauriTavern 的本地扩展。用单字段函数传输正文，支持 Google 流式参数分片和按完整标签截停。请求和凭据继续由 TauriTavern 的原生 Google Vertex AI 连接处理。

## 本地安装

1. 关闭 TauriTavern。
2. 将完整的 `vertex-native-tavern` 目录放进该应用数据目录下的 `default-user/extensions/`。确认扩展目录下直接包含 `manifest.json`。
3. 启动 TauriTavern。到「API 连接 → Google Vertex AI」，打开「Vertex 原生正文传输」，勾选启用，并打开酒馆的「流式传输」。一次只启用一个改写 Vertex 请求的抗截断扩展。
4. 可选填写模型 ID，以及截停标签、完整出现次数和豁免标签。比如 `UpdateVariable` 和 `1` 会保留第一对完整标签，结束标签后的内容会舍弃。需要后续栏目时留空关闭截停。

发布成独立 Git 仓库时，`manifest.json`、`index.js` 和 `transport.mjs` 应位于仓库根目录。之后可在 TauriTavern 的「扩展程序 → 安装扩展」填写仓库地址。

从扩展管理器禁用本扩展并重启，可恢复 TauriTavern 的原生路径。

## 兼容范围

- Google 官方 Vertex 连接、Gemini 文本、单候选、真流式。扩展默认关闭，保留原生思考事件、上游结束码和可用的用量帧。
- 使用客户端工具、内置工具或联网搜索时，Canary 原生 Vertex 通道负责组装并保留工具续轮。扩展会原样转发对应的请求，包括历史消息携带 Gemini 原生工具事件的回合。其他提供商、中转地址、结构化响应或生图也按原路径发送。兼容的正文传输请求可使用 JSON 附加参数。
- 最大回复超过 65,536 tokens 时，原生连接每段最多请求 32,768 tokens，最多五段。若一段收到长度或函数格式中断，且已经输出正文并剩有预算，扩展会带着原始消息、工具及完整已输出正文发起下一段。每段都合并进同一条酒馆回复。接力时会去掉可确认的重复开头或接缝重叠，并交付上一段结束标志之后的用量帧。
- 首段和续写段在输出内容前遇到 429 或 503 时，可以重发同一段。每段独立计数，0 次关闭额外重试。默认首次等 10 秒，后续间隔逐步翻倍并加入少量随机延迟。支持 HTTP 和流内错误，以及 `Retry-After` 或 `RetryInfo`。如果上游要求等待超过 300 秒，将直接报告错误。收到本段内容后发生错误时，保留已交付内容并停止重试。
- Canary 的 `/llmlog` 打开请求查看器，可在实际生成后查看 Vertex 请求及响应。提示词管理器的「预览请求」在扩展改写前组装，适合检查酒馆预设。
- 上游正常完成、安全结束或达到截停标签时结束当前回复。取消当前回复也会取消后续请求。遇到意外断流会显示错误并保留已收到的正文。
- 请求期限由 TauriTavern 原生连接和 Google 端点决定。扩展沿用酒馆的取消信号，原生请求不经过 8050 控制台。
- 在使用正文传输工具的回合，聊天历史采用还原后的完整正文。扩展会丢弃本轮的 Gemini 单段快照，以免下一个聊天回合只引用末段或重放正文工具。
- 原生连接通过 TauriTavern 的 Vertex `v1` 路径。分段续写用新的请求和完整正文衔接。需要 Google `v1beta1` 令牌续接、弱网请求缓冲、账号轮换、Cookie 通道和代理控制台时，请使用 vertex2openai。

## 验收

使用 Node.js 20 或更新版本执行 `node --test transport.test.mjs`。测试使用模拟 Vertex 流和本地 fetch 替身。正式使用前可先在隔离的测试项目，用少量正常请求验证当前 TauriTavern 和模型的实际兼容性。

功能设计参考 [ken050210/vertex-streaming-anti-truncation](https://github.com/ken050210/vertex-streaming-anti-truncation) 的公开文档。本项目独立实现。
