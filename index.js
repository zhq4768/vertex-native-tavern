import { resumeRetryDefaults, vertexFetch } from "./transport.mjs";

const key = "vertex-native-text-transport";
const context = globalThis.SillyTavern?.getContext?.();
const registered = Symbol.for(key);

if (globalThis.__TAURITAVERN__ && context && !globalThis[registered]) {
  globalThis[registered] = true;
  const readSettings = () => context.extensionSettings?.[key] || {};
  let status;
  const notify = text => { if (status?.isConnected) status.textContent = text; };
  globalThis.fetch = vertexFetch(globalThis.fetch.bind(globalThis), readSettings, notify);

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

    panel.addEventListener("change", () => {
      const settings = { enabled: enabled.checked, model: model.value.trim(), tag: tag.value.trim(),
        count: count.valueAsNumber, exempt: exempt.value.trim(),
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
