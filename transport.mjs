const endpoint = "/api/backends/chat-completions/generate";
const toolName = "vertex_deliver_text";
const segmentBudget = 32768;
const maxSegments = 5;
export const resumeRetryDefaults = { retryCount: 3, retrySeconds: 10 };
const transientStatuses = new Set([429, 503]);
const tagName = /^[A-Za-z_][A-Za-z0-9_.:\x2d]{0,63}$/;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const apiErrorLabel = /^\[API\s*(?:Error|错误|錯誤)\]/i;
const statusMessage = /\b(?:http(?:\s+status)?|status(?:\s+code)?)\s*[:=]?\s*(429|503)\b|\b(503)\s+(?:Service\s+)?Unavailable\b|\b(429)\s+(?:Too\s+Many\s+Requests|Resource\s+Exhausted)\b/i;
const nativeToolFields = ["toolCall", "toolResponse", "functionCall", "functionResponse", "executableCode", "codeExecutionResult"];

function statusFromMessage(message) {
  const match = statusMessage.exec(message);
  if (match) return Number(match[1] || match[2] || match[3]);
  if (/\bRESOURCE_EXHAUSTED\b/i.test(message)) return 429;
  if (/\bUNAVAILABLE\b/i.test(message)) return 503;
  return 0;
}
const terminal = new Set(["STOP", "MAX_TOKENS", "SAFETY", "RECITATION", "BLOCKLIST",
  "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "MODEL_ARMOR"]);

function transientStatus(data) {
  if (data.promptFeedback?.blockReason) return 0;
  if (object(data.error)) {
    const code = Number(data.error.code);
    if (code >= 400 && code <= 599) return transientStatuses.has(code) ? code : 0;
    if (data.error.status === "UNAVAILABLE") return 503;
    if (data.error.status === "RESOURCE_EXHAUSTED") return 429;
    return statusFromMessage(data.error.message || "");
  }
  const candidate = data.candidates?.[0];
  const content = candidate?.content;
  const text = content?.parts?.[0]?.text;
  // The TauriTavern bridge sends its API errors as a role-less text part.
  if (candidate?.finishReason || content?.role || content?.parts?.length !== 1 ||
      typeof text !== "string" || !apiErrorLabel.test(text)) return 0;
  return statusFromMessage(text);
}

function retryDelay(headers, seconds, attempt, error) {
  const ceiling = Math.max(seconds * 1000, 120000);
  const base = Math.min(seconds * 1000 * 2 ** attempt, ceiling);
  let delay = base + (attempt ? Math.floor(Math.random() * Math.min(base / 4, ceiling - base)) : 0);
  const header = headers.get("Retry-After")?.trim();
  if (header) {
    const hint = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
    if (hint > 300000) return null;
    if (Number.isFinite(hint)) delay = Math.max(hint, delay);
  }
  for (const detail of Array.isArray(error?.details) ? error.details : []) {
    if (detail?.['@type'] !== 'type.googleapis.com/google.rpc.RetryInfo') continue;
    const hint = /^(\d+(?:\.\d+)?)s$/.exec(detail.retryDelay || "");
    if (hint && Number(hint[1]) > 300) return null;
    if (hint) delay = Math.max(Number(hint[1]) * 1000, delay);
  }
  return delay;
}

function waitForRetry(delay, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delay);
    function abort() {
      clearTimeout(timeout);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function nextRetry(state, headers, error) {
  if (!state || state.attempts >= state.count) return null;
  return retryDelay(headers, state.seconds, state.attempts, error);
}

async function retryHttp(response, state) {
  while (transientStatuses.has(response.status) && state.attempts < state.count) {
    // TauriTavern normally forwards HTTP failures as SSE. The HTTP fallback
    // also handles structured hints when the bridge returns a JSON response.
    const payload = response.headers.get("content-type")?.includes("json")
      ? await response.clone().json().catch(() => null) : null;
    const delay = nextRetry(state, response.headers, payload?.error);
    if (delay === null) break;
    try { await response.body?.cancel(); } catch {}
    response = await state.retry(delay, response.status, ++state.attempts);
  }
  return response;
}

export function prepareNativeRequest(body, settings) {
  if (!settings.enabled || body.chat_completion_source !== "vertexai" || body.stream !== true ||
      !Array.isArray(body.messages) ||
      body.reverse_proxy || !/^gemini-[\w.-]+$/i.test(body.model || "") ||
      /image|nano-banana|embedding/i.test(body.model) ||
      (settings.model && settings.model !== body.model) ||
      body.tools?.length || body.functions?.length || body.toolConfig ||
      ![undefined, null, "auto", "none"].includes(body.tool_choice) ||
      body.function_call || body.messages.some(m => m.role === "tool" || m.role === "function" || m.tool_calls?.length ||
        (Array.isArray(m.native?.gemini?.content?.parts) && m.native.gemini.content.parts.some(part =>
          object(part) && nativeToolFields.some(field => field in part)))) ||
      body.json_schema || body.responseSchema || (body.response_format && body.response_format.type !== "text") ||
      (body.responseMimeType && body.responseMimeType !== "text/plain") ||
      (body.n ?? 1) !== 1 || (body.best_of ?? 1) !== 1 || body.enable_web_search || body.request_images) return null;
  let added = body.custom_include_body;
  if (added == null || (typeof added === "string" && !added.trim())) added = {};
  else if (typeof added === "string") {
    try { added = JSON.parse(added); } catch { return null; }
  }
  if (!object(added) || ("generationConfig" in added && !object(added.generationConfig)) ||
      "tools" in added || "toolConfig" in added || "tool_config" in added || "continuationToken" in added ||
      ["candidateCount", "responseSchema", "responseJsonSchema", "responseMimeType"].some(k => k in (added.generationConfig || {}))) return null;
  const instruction = "Deliver the requested visible reply through vertex_deliver_text. Its content field contains the reply itself. Preserve the requested language and formatting. Finish the call once the reply is complete.";
  const messages = [...body.messages];
  const last = messages.at(-1);
  if (last?.role === "user" && typeof last.content === "string") {
    messages[messages.length - 1] = { ...last, content: last.content + "\n\n" + instruction };
  } else if (last?.role === "user" && Array.isArray(last.content)) {
    messages[messages.length - 1] = { ...last, content: [...last.content, { type: "text", text: instruction }] };
  } else {
    messages.push({ role: "user", content: instruction });
  }
  return { ...body, messages, custom_include_body: JSON.stringify({
    ...added,
    tools: [{ functionDeclarations: [{ name: toolName, description: "Deliver the visible reply.",
      parameters: { type: "OBJECT", properties: { content: { type: "STRING" } }, required: ["content"] },
    }] }],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [toolName],
      streamFunctionCallArguments: true } },
  }) };
}

export function tagRule(settings) {
  const { tag, exempt = "", count = 1 } = settings;
  if (!tagName.test(tag || "") || (exempt && (!tagName.test(exempt) || exempt === tag)) ||
      !Number.isInteger(count) || count < 1 || count > 999) return null;
  const markers = new Map();
  for (const name of exempt ? [tag, exempt] : [tag]) {
    markers.set("<" + name + ">", [name, 1]);
    markers.set("</" + name + ">", [name, -1]);
  }
  const max = Math.max(...[...markers.keys()].map(key => key.length));
  let pending = "", depth = 0, exemptDepth = 0, pairs = 0;
  return text => {
    const source = pending + text;
    for (let i = source.indexOf("<"); i !== -1; i = source.indexOf("<", i + 1)) {
      const end = source.indexOf(">", i + 1);
      if (end < 0 || end - i >= max) continue;
      const marker = markers.get(source.slice(i, end + 1));
      if (!marker) continue;
      const [name, change] = marker;
      if (name === exempt) exemptDepth = Math.max(0, exemptDepth + change);
      else if (!exemptDepth && (change > 0 || depth > 0)) {
        depth += change;
        if (!depth && ++pairs === count) return end + 1 - pending.length;
      }
    }
    const tail = source.slice(-(max - 1));
    const start = tail.lastIndexOf("<");
    const suffix = start < 0 ? "" : tail.slice(start);
    pending = [...markers.keys()].some(marker => marker !== suffix && marker.startsWith(suffix)) ? suffix : "";
    return null;
  };
}

function createDecoder(settings) {
  const cut = tagRule(settings);
  let previous = "", finish = "", incompleteArgs = false, hasText = false, usedTool = false;
  const body = [];
  let segmentStart = 0, overlap = "", buffered = "", replay = "", replayOffset = 0;
  function accept(text = "", flush = false) {
    if (replayOffset) {
      const expected = replay.slice(replayOffset, replayOffset + text.length);
      if (!flush && text === expected && replayOffset + text.length < replay.length) {
        replayOffset += text.length;
        return "";
      }
      let common = 0;
      while (common < expected.length && text[common] === expected[common]) common++;
      text = text.slice(common);
      replay = "";
      replayOffset = 0;
    }
    if (overlap) {
      buffered += text;
      const probe = replay.slice(0, 64);
      if (probe.length === 64 && buffered.startsWith(probe)) {
        text = buffered.slice(64);
        replayOffset = 64;
        overlap = buffered = "";
        return accept(text, flush);
      }
      if (!flush && (probe.startsWith(buffered) || overlap.includes(buffered))) return "";
      text = buffered;
      for (let length = Math.min(text.length, overlap.length); length >= 32; length--) {
        if (overlap.endsWith(text.slice(0, length))) {
          text = text.slice(length);
          break;
        }
      }
      overlap = buffered = replay = "";
    }
    return text;
  }
  return {
    frame(data, canContinue = false) {
      if (data.error || data.promptFeedback?.blockReason) return { data, end: true, status: "上游结束或拦截" };
      for (const choice of data.choices || []) {
        const { native } = choice.delta || {};
        const parts = native?.gemini?.content?.parts;
        if (native?.gemini && (usedTool || (Array.isArray(parts) &&
            parts.some(part => part?.functionCall?.name === toolName)))) {
          // The final TauriTavern snapshot feeds chat history. Use the restored
          // visible message for future turns when this snapshot contains our tool.
          delete native.gemini;
          if (Object.keys(native).length === 0) delete choice.delta.native;
        }
      }
      if (data.candidates?.length > 1) throw new Error("收到多个候选，无法确定正文");
      const candidate = data.candidates?.[0];
      if (!candidate) return { data };
      const reason = candidate.finishReason;
      const parts = [];
      let stopped = false;
      for (const part of candidate.content?.parts || []) {
        const call = part.functionCall;
        let text;
        if (call?.name === toolName || (incompleteArgs && call && !call.name)) {
          usedTool = true;
          const pieces = (call.partialArgs || []).filter(arg => arg.jsonPath === "$.content");
          if (!pieces.length && typeof call.args?.content === "string") {
            if (!call.args.content.startsWith(previous)) throw new Error("工具参数前后不一致");
            text = call.args.content.slice(previous.length);
            incompleteArgs = call.willContinue === true;
          } else {
            text = pieces.map(arg => typeof arg.stringValue === "string" ? arg.stringValue : "").join("");
            const lastPiece = pieces.at(-1);
            const more = call.willContinue ?? lastPiece?.willContinue;
            if (typeof more === "boolean") incompleteArgs = more;
            else if (pieces.length) incompleteArgs = true;
          }
          previous += text;
        } else if (typeof part.text === "string" && !part.thought) {
          if (apiErrorLabel.test(part.text) && !candidate.finishReason) {
            return { data, end: true, status: "TauriTavern 报告上游错误" };
          }
          text = part.text;
        } else {
          if (call) throw new Error("收到未预期的函数调用");
          parts.push(part);
          continue;
        }
        if (text) {
          text = accept(text);
        }
        if (text) {
          hasText = true;
          const end = cut?.(text) ?? null;
          const delivered = end === null ? text : text.slice(0, end);
          body.push(delivered);
          parts.push(call ? { text: delivered } : { ...part, text: delivered });
          if (end !== null) { stopped = true; break; }
        }
      }
      if (!stopped && reason && reason !== "FINISH_REASON_UNSPECIFIED") {
        const tail = accept("", true);
        if (tail) {
          const end = cut?.(tail) ?? null;
          const delivered = end === null ? tail : tail.slice(0, end);
          hasText = true;
          body.push(delivered);
          parts.push({ text: delivered });
          stopped = end !== null;
        }
      }
      if (stopped) {
        finish = "STOP";
        return { data: { candidates: [{ index: 0, finishReason: "STOP", content: { role: "model", parts } }] },
          tagStopped: true };
      }
      if (canContinue && ["MAX_TOKENS", "MALFORMED_FUNCTION_CALL", "CONTINUATION"].includes(reason)) {
        const prefix = body.slice(segmentStart).some(text => text.trim()) ? body.join("") : "";
        if (prefix) {
          const { finishReason, continuationToken, ...rest } = candidate;
          return {
            data: { ...data, candidates: [{ ...rest, content: { ...candidate.content, parts } }] },
            prefix,
          };
        }
      }
      if (reason && reason !== "FINISH_REASON_UNSPECIFIED") {
        if (reason === "CONTINUATION") throw new Error("Google 要求续传；此版本的客户端扩展无法发起下一段");
        if (!terminal.has(reason)) throw new Error("上游生成未完成：" + reason);
        if (reason === "STOP" && (!hasText || incompleteArgs)) throw new Error("结束时正文为空或函数参数未闭合");
        finish = reason;
      }
      return { data: { ...data, candidates: [{ ...candidate, content: { ...candidate.content, parts } }] } };
    },
    nextSegment(prefix) {
      previous = finish = buffered = "";
      incompleteArgs = hasText = false;
      segmentStart = body.length;
      overlap = prefix.slice(-2048);
      replay = prefix;
      replayOffset = 0;
    },
    complete() {
      if (!finish) throw new Error("上游断流，缺少结束状态");
      return "Google 结束状态：" + finish;
    },
  };
}

export function restoreNativeStream(response, settings, notify = () => {}, continuation) {
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
  let reader = response.body.getReader();
  let decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const receive = createDecoder(settings);
  let incoming = "", ended = false, pendingPrefix = "";
  let tagStopped = false, receivedStopUsage = false, upstreamFinish, usageSeen = false;
  let retryState = continuation?.retryState;
  let responseHeaders = response.headers;
  const report = continuation?.report ?? (() => {});
  const event = value => encoder.encode("data: " + (typeof value === "string" ? value : JSON.stringify(value)) + "\n\n");
  async function stop(controller, status, outcome, fields = {}) {
    ended = true;
    notify(status);
    report("end", { outcome, usageSeen, ...fields });
    controller.enqueue(event("[DONE]"));
    controller.close();
    try { await reader.cancel(); } catch {}
  }
  function finishTagged(controller) {
    if (settings.waitForStopUsage === true) {
      controller.enqueue(event({ candidates: [{ index: 0, finishReason: "STOP", content: { role: "model", parts: [] } }] }));
    }
    return stop(controller, receivedStopUsage ? "已按标签截停，已收到上游用量" : "已按标签截停，未收到后续用量",
      "tag-stop", { finishReason: upstreamFinish, usageAfterTag: receivedStopUsage });
  }
  function finishStream(controller) {
    return tagStopped ? finishTagged(controller)
      : stop(controller, receive.complete(), "finished", { finishReason: upstreamFinish });
  }
  async function attach(next) {
    if (!ended) next = await retryHttp(next, retryState);
    if (ended) {
      await next.body?.cancel();
      return;
    }
    if (!next.ok || !next.body || !next.headers.get("content-type")?.includes("text/event-stream")) {
      await next.body?.cancel();
      throw new Error("Vertex 正文续写请求未建立流，HTTP " + next.status);
    }
    reader = next.body.getReader();
    responseHeaders = next.headers;
    decoder = new TextDecoder();
    incoming = "";
  }
  async function openNext() {
    const prefix = pendingPrefix;
    pendingPrefix = "";
    try { await reader.cancel(); } catch {}
    if (ended) return;
    upstreamFinish = undefined;
    receive.nextSegment(prefix);
    retryState.attempts = 0;
    await attach(await continuation.open(prefix));
  }
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        while (!ended) {
          const separator = /\r?\n\r?\n/.exec(incoming);
          if (!separator) {
            const { value, done } = await reader.read();
            if (ended) return;
            if (done) {
              if (!pendingPrefix) return finishStream(controller);
              await openNext();
              continue;
            }
            incoming += decoder.decode(value, { stream: true });
            continue;
          }
          const block = incoming.slice(0, separator.index);
          incoming = incoming.slice(separator.index + separator[0].length);
          const data = block.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
          if (!data) continue;
          if (data.trim() === "[DONE]") {
            if (!pendingPrefix) return finishStream(controller);
            await openNext();
            continue;
          }
          const parsed = JSON.parse(data);
          const reason = parsed.candidates?.[0]?.finishReason;
          if (terminal.has(reason) || ["CONTINUATION", "MALFORMED_FUNCTION_CALL"].includes(reason)) upstreamFinish = reason;
          const status = transientStatus(parsed);
          if (tagStopped) {
            if (status || parsed.error || parsed.promptFeedback?.blockReason ||
                parsed.candidates?.[0]?.content?.parts?.some(part => apiErrorLabel.test(part.text || ""))) {
              report("upstream-error", status ? { status } : {});
              return finishTagged(controller);
            }
            if (object(parsed.usageMetadata)) {
              receivedStopUsage = usageSeen = true;
              controller.enqueue(event({ usageMetadata: parsed.usageMetadata }));
              return;
            }
            continue;
          }
          if (status) {
            report("upstream-error", { status });
            if (pendingPrefix) {
              await openNext();
              continue;
            }
            const delay = nextRetry(retryState, responseHeaders, parsed.error);
            if (delay !== null) {
              try { await reader.cancel(); } catch {}
              if (ended) return;
              await attach(await retryState.retry(delay, status, ++retryState.attempts));
              continue;
            }
          }
          if (retryState && (parsed.candidates?.some(candidate => candidate.finishReason || candidate.content?.parts?.length)
              || parsed.choices?.some(choice => choice.finish_reason || Object.keys(choice.delta || {}).some(key => key !== "role")))) {
            retryState.attempts = retryState.count;
          }
          const restored = receive.frame(parsed, continuation?.available());
          if (restored.prefix) pendingPrefix = restored.prefix;
          else if (terminal.has(restored.data.candidates?.[0]?.finishReason)) pendingPrefix = "";
          if (!restored.end && restored.data.candidates?.[0]?.content?.parts?.some(part =>
              typeof part.text === "string" && part.text.length && !part.thought)) report("text");
          if (object(parsed.usageMetadata)) usageSeen = true;
          if (restored.tagStopped) {
            pendingPrefix = "";
            tagStopped = true;
            receivedStopUsage = object(parsed.usageMetadata);
            report("tag-stop");
            const { candidates } = restored.data;
            const [{ finishReason, ...visible }] = candidates;
            if (settings.waitForStopUsage === true) {
              // Leave the UI stream open, but never forward the hidden tail or its history snapshot.
              controller.enqueue(event({ candidates: [visible] }));
              if (receivedStopUsage) controller.enqueue(event({ usageMetadata: parsed.usageMetadata }));
              notify("正文已按标签截停，等待 Google 结束并回报用量");
              return;
            }
            controller.enqueue(event({ ...restored.data, ...(receivedStopUsage ? { usageMetadata: parsed.usageMetadata } : {}) }));
            return finishTagged(controller);
          }
          controller.enqueue(event(restored.data));
          if (restored.end) await stop(controller, restored.status, parsed.promptFeedback?.blockReason ? "blocked" : "upstream-error",
            { finishReason: upstreamFinish });
          return;
        }
      } catch (error) {
        if (ended) return;
        if (error?.name === "AbortError") {
          await stop(controller, "Vertex 生成已取消", "cancelled");
          return;
        }
        if (tagStopped) {
          report("tail-error");
          return finishTagged(controller);
        }
        controller.enqueue(event({ error: { code: "vertex_text_transport", message: error.message } }));
        await stop(controller, error.message, "stream-error", { finishReason: upstreamFinish });
      }
    },
    cancel(reason) {
      ended = true;
      report("end", { outcome: "cancelled", usageSeen });
      continuation?.cancel(reason);
      return reader.cancel(reason);
    },
  });
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(stream, { status: response.status, headers });
}

export function vertexFetch(originalFetch, readSettings, notify = () => {}, origin = location.origin, onDiagnostic = () => {}) {
  let sequence = 0;
  return async (input, init) => {
    const settings = readSettings();
    if (!settings.enabled) return originalFetch(input, init);
    let url;
    try {
      url = new URL(input instanceof Request ? input.url : input, origin);
    } catch { return originalFetch(input, init); }
    const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "POST" || url.origin !== origin || url.pathname !== endpoint) {
      return originalFetch(input, init);
    }
    const request = new Request(input instanceof Request ? input.clone() : url, init);
    let payload;
    try { payload = await request.clone().json(); } catch { return originalFetch(request); }
    const prepared = object(payload) && prepareNativeRequest(payload, settings);
    if (payload?.chat_completion_source !== "vertexai") return originalFetch(request);
    const started = performance.now();
    const diagnostic = { request: ++sequence, startedAt: new Date().toISOString(), outcome: "running", events: [] };
    let segments = 0;
    function report(stage, fields = {}) {
      if (diagnostic.outcome !== "running") return;
      const elapsedMs = Math.round(performance.now() - started);
      if (stage === "text") {
        if (diagnostic.firstTextMs !== undefined) return;
        diagnostic.firstTextMs = elapsedMs;
      }
      if (stage === "end") Object.assign(diagnostic, { elapsedMs }, fields);
      diagnostic.events.push({ stage, elapsedMs, segment: segments || 1, ...fields });
      if (diagnostic.events.length > 40) diagnostic.events.shift();
      onDiagnostic({ ...diagnostic, events: [...diagnostic.events] });
    }
    if (!prepared) {
      report("end", { outcome: "native-passthrough" });
      return originalFetch(request);
    }
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    const send = async (payload, signal) => {
      const options = { headers, body: JSON.stringify(payload), ...(signal ? { signal } : {}) };
      report("request");
      const response = await (input instanceof Request
        ? originalFetch(new Request(request, options))
        : originalFetch(input, { ...init, ...options }));
      report("http", { status: response.status });
      return response;
    };
    const added = JSON.parse(prepared.custom_include_body);
    const originalBudget = added.generationConfig?.maxOutputTokens ?? prepared.max_tokens;
    let remaining = originalBudget;
    const cancel = new AbortController();
    const segmented = Number.isSafeInteger(originalBudget) && originalBudget > 65536;
    const makeSegment = prefix => {
      const budget = Math.min(remaining, segmentBudget);
      remaining -= budget;
      segments++;
      const messages = prefix ? [...prepared.messages, {
        role: "user",
        content: "根据原始任务、角色设定和预设格式，在以下已发送正文的末尾接着写。接上未完的句子、段落或标签，从断点直接输出新增正文。正文继续通过 vertex_deliver_text 工具的 content 参数交付。\n\n" + prefix,
      }] : prepared.messages;
      const custom = added.generationConfig?.maxOutputTokens === undefined
        ? prepared.custom_include_body
        : JSON.stringify({ ...added, generationConfig: { ...added.generationConfig, maxOutputTokens: budget } });
      return { ...prepared, messages, max_tokens: budget, custom_include_body: custom };
    };
    let nextPayload = segmented ? makeSegment("") : prepared;
    const continuationSignal = AbortSignal.any([request.signal, cancel.signal]);
    const retryCount = Number.isInteger(settings.retryCount) && settings.retryCount >= 0 && settings.retryCount <= 20
      ? settings.retryCount : resumeRetryDefaults.retryCount;
    const retrySeconds = Number.isInteger(settings.retrySeconds) && settings.retrySeconds >= 0 && settings.retrySeconds <= 300
      ? settings.retrySeconds : resumeRetryDefaults.retrySeconds;
    const retryState = { count: retryCount, seconds: retrySeconds, attempts: 0,
      retry: async (delay, status, attempt) => {
        report("retry", { status, attempt, maxAttempts: retryCount, waitMs: delay });
        notify(`Vertex 第 ${segments || 1} 段遇到 ${status}，${Math.round(delay / 100) / 10} 秒后重试（${attempt}/${retryCount}）`);
        await waitForRetry(delay, continuationSignal);
        continuationSignal.throwIfAborted();
        return send(nextPayload, continuationSignal);
      },
    };
    let response;
    try {
      response = await retryHttp(await send(nextPayload), retryState);
    } catch (error) {
      report("end", { outcome: continuationSignal.aborted ? "cancelled" : "network-error" });
      throw error;
    }
    if (!response.ok) {
      notify("上游 HTTP " + response.status);
      report("end", { outcome: "http-error", status: response.status });
    } else if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      report("end", { outcome: "non-stream-response", status: response.status });
    }
    return restoreNativeStream(response, settings, notify, {
      retryState,
      report,
      available: () => segmented && remaining > 0 && segments < maxSegments && !continuationSignal.aborted,
      open: prefix => {
        continuationSignal.throwIfAborted();
        nextPayload = makeSegment(prefix);
        notify("Vertex 正文续写，第 " + segments + " 段");
        return send(nextPayload, continuationSignal);
      },
      cancel: reason => cancel.abort(reason),
    });
  };
}
