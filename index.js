import { resumeRetryDefaults, vertexFetch } from "./transport.mjs";

const key = "vertex-native-text-transport";
const context = globalThis.SillyTavern?.getContext?.();
const registered = Symbol.for(key);

if (globalThis.__TAURITAVERN__ && context && !globalThis[registered]) {
  globalThis[registered] = true;
  const readSettings = () => context.extensionSettings?.[key] || {};
  let status;
  const notify = text => { if (status?.isConnected) status.textContent = text; };
  const recent = new Map();
  let refreshRecent = () => {};
  globalThis.fetch = vertexFetch(globalThis.fetch.bind(globalThis), readSettings, notify, location.origin, record => {
    recent.set(record.request, record);
    if (recent.size > 8) recent.delete(recent.keys().next().value);
    refreshRecent();
  });

  function mount() {
    const parent = document.getElementById("vertexai_form");
    if (!parent || document.getElementById(key)) return;
    const stored = readSettings();
    const panel = document.createElement("details");
    panel.id = key;
    const title = document.createElement("summary");
    title.textContent = "Vertex 原生正文传输";
    panel.append(title);

    function field(label, type, initial, placeholder = "") {
      const row = document.createElement("label");
      row.style.display = "block";
      const input = document.createElement("input");
      input.type = type;
      if (type === "checkbox") input.checked = initial === true;
      else input.value = initial ?? "";
      input.placeholder = placeholder;
      if (type !== "checkbox") input.className = "text_pole";
      row.append(label, input);
      panel.append(row);
      return input;
    }
    const enabled = field("启用抗截断传输", "checkbox", stored.enabled);
    const model = field("只用于指定模型", "text", stored.model, "留空适用于兼容模型");
    const tag = field("截停标签", "text", stored.tag, "留空关闭");
    const count = field("完整标签对次数", "number", stored.count ?? 1);
    count.min = "1";
    count.max = "999";
    count.step = "1";
    const exempt = field("豁免标签", "text", stored.exempt, "可留空");
    const waitForStopUsage = field("截停后等 Google 结束并回报用量（后续仍可能计费）", "checkbox", stored.waitForStopUsage);
    const retryCount = field("每段重试次数（0 次关闭）", "number", stored.retryCount ?? resumeRetryDefaults.retryCount);
    const retrySeconds = field("首次重试间隔（秒）", "number", stored.retrySeconds ?? resumeRetryDefaults.retrySeconds);
    for (const [input, maximum] of [[retryCount, "20"], [retrySeconds, "300"]]) {
      input.min = "0";
      input.max = maximum;
      input.step = "1";
      input.required = true;
    }
    status = document.createElement("small");
    status.setAttribute("role", "status");
    status.textContent = "适用于原生 Vertex 真流式文本。最大回复超过 65,536 tokens 时启用分段续写。";
    panel.append(status);

    const diagnostics = document.createElement("details");
    const diagnosticsTitle = document.createElement("summary");
    diagnosticsTitle.textContent = "最近请求";
    const requestList = document.createElement("select");
    requestList.setAttribute("aria-label", "选择要查看的 Vertex 请求");
    const log = document.createElement("pre");
    log.style.whiteSpace = "pre-wrap";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "复制诊断";
    const outcomeLabels = {
      running: "进行中", finished: "已结束", "tag-stop": "标签截停", cancelled: "已取消",
      "native-passthrough": "原生直通", blocked: "上游拦截", "upstream-error": "上游报错",
      "stream-error": "流式错误", "http-error": "HTTP 错误", "network-error": "网络错误",
      "non-stream-response": "收到非流式响应",
    };
    let pinned;
    function showRecord() {
      const record = recent.get(Number(requestList.value));
      log.textContent = record ? JSON.stringify({ extensionVersion: "0.1.8", ...record }, null, 2) : "暂无请求";
      copy.disabled = !record;
    }
    refreshRecent = () => {
      if (!diagnostics.open) return;
      requestList.replaceChildren(...[...recent.values()].reverse().map(record => {
        const option = document.createElement("option");
        option.value = record.request;
        option.textContent = `请求 #${record.request} · ${outcomeLabels[record.outcome]}`;
        return option;
      }));
      if (recent.has(pinned)) requestList.value = pinned;
      showRecord();
    };
    diagnostics.addEventListener("toggle", refreshRecent);
    requestList.addEventListener("change", () => { pinned = Number(requestList.value); showRecord(); });
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(log.textContent);
        notify("Vertex 请求诊断已复制");
      } catch {
        notify("系统未允许复制，请选中诊断文字手动复制");
      }
    });
    diagnostics.append(diagnosticsTitle, requestList, copy, log);
    panel.append(diagnostics);

    panel.addEventListener("change", event => {
      if (diagnostics.contains(event.target)) return;
      const settings = { enabled: enabled.checked, model: model.value.trim(), tag: tag.value.trim(),
        count: count.valueAsNumber, exempt: exempt.value.trim(),
        waitForStopUsage: waitForStopUsage.checked,
        retryCount: retryCount.valueAsNumber, retrySeconds: retrySeconds.valueAsNumber };
      if (!retryCount.validity.valid || !retrySeconds.validity.valid) {
        notify("重试次数可填 0–20，间隔可填 0–300 秒，均填整数。");
        return;
      }
      const name = /^[A-Za-z_][A-Za-z0-9_.:\x2d]{0,63}$/;
      if (settings.tag && (!name.test(settings.tag) || (settings.exempt &&
          (!name.test(settings.exempt) || settings.exempt === settings.tag)) ||
          !Number.isInteger(settings.count) || settings.count < 1 || settings.count > 999)) {
        notify("填写合法标签名和 1–999 的完整次数。豁免标签须与截停标签不同。");
        return;
      }
      context.extensionSettings[key] = settings;
      context.saveSettingsDebounced?.();
      notify("设置已保存。");
    });
    parent.append(panel);
  }
  const events = context.eventTypes ?? context.event_types;
  const ready = events?.APP_READY ?? events?.APP_INITIALIZED;
  if (ready) context.eventSource?.on(ready, mount);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
}
