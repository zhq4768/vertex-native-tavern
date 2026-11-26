import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareNativeRequest, restoreNativeStream, tagRule, vertexFetch } from "./transport.mjs";

const origin = "http://127.0.0.1:8000";
const route = "/api/backends/chat-completions/generate";
const config = { enabled: true };
const request = { chat_completion_source: "vertexai", model: "gemini-4-argon", stream: true,
  max_tokens: 500000, messages: [{ role: "user", content: "Write the next chapter." }] };
const frame = (parts, finishReason) => ({ candidates: [{ index: 0, content: { role: "model", parts }, finishReason }] });
const tool = (text, willContinue) => ({
  functionCall: { name: "vertex_deliver_text", partialArgs: [{ jsonPath: "$.content", stringValue: text, willContinue }], willContinue },
});
const encode = value => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
const upstream = (...frames) => new Response(frames.map(encode).join(""), {
  headers: { "content-type": "text/event-stream" },
});
const visible = text => text.split("\n").filter(line => line.startsWith("data: {"))
  .flatMap(line => JSON.parse(line.slice(6)).candidates || [])
  .flatMap(candidate => candidate.content?.parts || []).filter(part => !part.thought)
  .map(part => part.text || "").join("");

test("request keeps budgets and unrelated additional settings", () => {
  const result = prepareNativeRequest({ ...request, custom_include_body: '{"labels":{"fixture":"test"}}' }, config);
  const added = JSON.parse(result.custom_include_body);
  assert.equal(result.max_tokens, 500000);
  assert.equal(added.labels.fixture, "test");
  assert.equal(added.toolConfig.functionCallingConfig.streamFunctionCallArguments, true);
  assert.equal(request.messages[0].content, "Write the next chapter.");
});

test("unsupported requests pass through without changing the request", async () => {
  for (const addition of [{ reverse_proxy: "https://relay.invalid" }, { stream: false },
    { tools: [{ type: "function" }] }, { custom_include_body: "toolConfig: any" },
    { enable_web_search: true, tools: [{ type: "function", function: { name: "lookup" } }] },
    { messages: [{ role: "assistant", native: { gemini: { content: { parts: [
      { toolResponse: { id: "search", response: {} } },
    ] } } } }] },
    { custom_include_body: '{"generationConfig":1}' }]) {
    assert.equal(prepareNativeRequest({ ...request, ...addition }, config), null);
  }
  const raw = new Request(origin + "/different", { method: "POST", body: "original" });
  const wrapped = vertexFetch(async req => new Response(await req.text()), () => config, undefined, origin);
  assert.equal(await (await wrapped(raw)).text(), "original");
});

test("initial HTTP then SSE 429 retry the same request within one retry budget", async () => {
  const requests = [];
  const wrapped = vertexFetch(async (_, init) => {
    requests.push(JSON.parse(init.body));
    if (requests.length === 1) return Response.json({ error: { code: 429 } }, { status: 429 });
    if (requests.length === 2) return upstream({ candidates: [{ content: { parts: [
      { text: "[API Error] RESOURCE_EXHAUSTED" },
    ] } }] });
    return upstream(frame([tool("Recovered", false)], "STOP"), "[DONE]");
  }, () => ({ ...config, retryCount: 2, retrySeconds: 0 }), undefined, origin);
  const response = await wrapped(route, { method: "POST", body: JSON.stringify({ ...request, max_tokens: 8192 }) });
  assert.equal(visible(await response.text()), "Recovered");
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.slice(1), [requests[0], requests[0]]);
});

test("same-origin adapter consumes Google native SSE on the same URL", async () => {
  let count = 0;
  const signal = new AbortController().signal;
  const wrapped = vertexFetch(async (input, init) => {
    assert.equal(input, route);
    const req = new Request(new URL(input, origin), init);
    count++;
    assert.equal(req.url, origin + route);
    assert.equal(req.headers.get("x-fixture"), "original");
    assert.equal(req.headers.has("X-Server-Timeout"), false);
    assert.equal(init.signal, signal);
    assert.equal((await req.json()).max_tokens, 32768);
    return upstream(frame([{ thought: true, text: "Reasoned." }, tool("Part ", true)]),
      frame([tool("two", false)], "STOP"), { usageMetadata: { totalTokenCount: 11 } });
  }, () => config, undefined, origin);
  const response = await wrapped(route, { method: "POST", body: JSON.stringify(request), headers: { "x-fixture": "original" }, signal });
  const output = await response.text();
  assert.equal(count, 1);
  assert.equal(visible(output), "Part two");
  assert.match(output, /"thought":true/);
  assert.match(output, /"totalTokenCount":11/);
  assert.match(output, /data: \[DONE\]/);
});

test("native v1 chains short requests with the original messages, tool and complete visible prefix", async () => {
  const longOpening = Array.from({ length: 180 }, (_, i) => `第${i}号站台的灯还亮着。`).join(" ");
  const first = longOpening + " The pilot walked along the pier. An old boat was waiting alongside the last post.";
  const overlap = "An old boat was waiting alongside the last post.";
  const second = " A small light blinked in the cabin.";
  const third = " She stepped aboard.";
  const sent = [];
  const wrapper = vertexFetch(async (_input, init) => {
    sent.push(JSON.parse(init.body));
    if (sent.length === 1) return upstream(frame([tool(first, true)], "MAX_TOKENS"),
      { usageMetadata: { totalTokenCount: 15 } }, "[DONE]");
    if (sent.length === 2) return upstream(frame([tool(overlap.slice(0, 20), true)]),
      frame([tool(overlap.slice(20) + second, true)], "MALFORMED_FUNCTION_CALL"));
    const prefix = first + second;
    return upstream(frame([tool(prefix.slice(0, 33), true)]), frame([tool(prefix.slice(33), true)]),
      frame([tool(third, false)], "STOP"), { choices: [{ delta: { native: {
        gemini: { content: { role: "model", parts: [{ text: third }] } },
      } } }] });
  }, () => config, undefined, origin);
  const response = await wrapper(route, { method: "POST", body: JSON.stringify({
    ...request,
    max_tokens: 80000,
    custom_include_body: '{"generationConfig":{"maxOutputTokens":80000,"temperature":0.8}}',
    messages: [{ role: "system", content: "Preset" }, ...request.messages],
  }) });
  const text = await response.text();
  assert.equal(visible(text), first + second + third);
  assert.equal((text.match(/\[DONE\]/g) || []).length, 1);
  assert.match(text, /"totalTokenCount":15/);
  assert.doesNotMatch(text, /MAX_TOKENS|MALFORMED_FUNCTION_CALL|continuationToken|"native"/);
  assert.deepEqual(sent.map(entry => entry.max_tokens), [32768, 32768, 14464]);
  for (const [i, entry] of sent.entries()) {
    const added = JSON.parse(entry.custom_include_body);
    assert.equal(added.generationConfig.maxOutputTokens, entry.max_tokens);
    assert.equal(added.generationConfig.temperature, 0.8);
    assert.deepEqual(added.tools, JSON.parse(sent[0].custom_include_body).tools);
    assert.deepEqual(added.toolConfig, JSON.parse(sent[0].custom_include_body).toolConfig);
    if (i) {
      assert.deepEqual(entry.messages.slice(0, -2), sent[0].messages);
      assert.deepEqual(entry.messages.at(-2), { role: "assistant", content: i === 1 ? first : first + second });
      assert.equal(entry.messages.at(-1).role, "user");
      assert.match(entry.messages.at(-1).content, /vertex_deliver_text.*content/);
      assert.ok(!entry.messages.at(-1).content.includes(first));
    }
  }
  assert.deepEqual(sent[0].messages, prepareNativeRequest({
    ...request, messages: [{ role: "system", content: "Preset" }, ...request.messages],
  }, config).messages);
});

test("503 on a follow-up retries the exact segment and leaves the budget and later segments intact", async () => {
  const requests = [];
  const wrapper = vertexFetch(async (_input, init) => {
    requests.push(init.body);
    switch (requests.length) {
      case 1:
        return upstream(frame([tool("First. ", true)], "MAX_TOKENS"));
      case 2:
      case 4:
        return new Response(null, { status: 503, headers: { "Retry-After": "0" } });
      case 3:
        return upstream(frame([tool("Second. ", true)], "MAX_TOKENS"));
      default:
        return upstream(frame([tool("Third.", false)], "STOP"));
    }
  }, () => ({ ...config, retrySeconds: 0 }), undefined, origin);
  const output = await (await wrapper(route, { method: "POST", body: JSON.stringify({ ...request, max_tokens: 80000 }) })).text();
  assert.equal(visible(output), "First. Second. Third.");
  assert.equal(requests[1], requests[2]);
  assert.equal(requests[3], requests[4]);
  assert.deepEqual(requests.map(body => JSON.parse(body).max_tokens), [32768, 32768, 32768, 14464, 14464]);
  assert.equal((output.match(/\[DONE\]/g) || []).length, 1);
});

test("configured retries include both 503 and 429 frames before follow-up output", async () => {
  const errorFrame = { candidates: [{ index: 0, content: {
    parts: [{ text: "[API 错误]\nVertex AI endpoint failed with status 503: temporarily unavailable" }],
  } }] };
  const requests = [];
  const wrapper = vertexFetch(async (_input, init) => {
    requests.push(init.body);
    if (requests.length === 1) return upstream(frame([tool("First. ", true)], "MAX_TOKENS"));
    if (requests.length === 2) return upstream({ usageMetadata: { totalTokenCount: 15 } }, errorFrame, "[DONE]");
    if (requests.length === 3) return upstream({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } });
    return upstream(frame([tool("Second.", false)], "STOP"));
  }, () => ({ ...config, retryCount: 2, retrySeconds: 0 }), undefined, origin);
  const output = await (await wrapper(route, { method: "POST", body: JSON.stringify(request) })).text();
  assert.equal(visible(output), "First. Second.");
  assert.equal(requests.length, 4);
  assert.equal(requests[1], requests[2]);
  assert.equal(requests[2], requests[3]);
  assert.doesNotMatch(output, /status 503/);
});

test("503 after new text keeps the text already sent and stops without replay", async () => {
  let count = 0;
  const wrapper = vertexFetch(async () => {
    count++;
    if (count === 1) {
      return upstream(frame([tool("First. ", true)], "MAX_TOKENS"), { error: { code: 503 } });
    }
    return upstream(frame([tool("Second is partial.", true)]), { error: { code: 503, status: "UNAVAILABLE" } });
  }, () => config, undefined, origin);
  const output = await (await wrapper(route, { method: "POST", body: JSON.stringify(request) })).text();
  assert.equal(visible(output), "First. Second is partial.");
  assert.match(output, /"code":503/);
  assert.equal(count, 2);
});

test("503 respects configured retry limits and an upstream request above the wait limit", async () => {
  for (const [retryCount, retryAfter, expectedCalls] of [[2, "0", 4], [0, "0", 2], [2, "301", 2]]) {
    let count = 0;
    const wrapper = vertexFetch(async () => {
      count++;
      if (count === 1) return upstream(frame([tool("First.", true)], "MAX_TOKENS"));
      return new Response(null, { status: 503, headers: { "Retry-After": retryAfter } });
    }, () => ({ ...config, retryCount, retrySeconds: 0 }), undefined, origin);
    const output = await (await wrapper(route, { method: "POST", body: JSON.stringify(request) })).text();
    assert.equal(visible(output), "First.");
    assert.match(output, /HTTP 503/);
    assert.equal(count, expectedCalls);
  }
});

test("cancelling while waiting to retry a follow-up prevents another request", async () => {
  const cancel = new AbortController();
  let count = 0;
  let notification;
  const wrapper = vertexFetch(async () => {
    count++;
    if (count === 1) return upstream(frame([tool("First.", true)], "MAX_TOKENS"));
    return new Response(null, { status: 503, headers: { "Retry-After": "3" } });
  }, () => ({ ...config, retryCount: 3, retrySeconds: 5 }), message => {
    if (message.includes("503")) {
      notification = message;
      setTimeout(() => cancel.abort(), 10);
    }
  }, origin);
  const response = await wrapper(route, { method: "POST", body: JSON.stringify(request), signal: cancel.signal });
  assert.equal(visible(await response.text()), "First.");
  assert.equal(count, 2);
  assert.match(notification, /5 秒后重试（1\/3）/);
});

test("native safety ends the existing stream without opening another request", async () => {
  let count = 0;
  const wrapper = vertexFetch(async () => {
    count++;
    return upstream(frame([tool("Partial text.", true)]), frame([], "SAFETY"));
  }, () => config, undefined, origin);
  const response = await wrapper(route, { method: "POST", body: JSON.stringify(request) });
  assert.match(await response.text(), /SAFETY/);
  assert.equal(count, 1);
});

test("TauriTavern history snapshot does not replay the extension's tool call", async () => {
  const parts = [tool("Part ", true), { functionCall: { partialArgs: [{ jsonPath: "$.content", stringValue: "two" }] } }];
  const snapshot = content => ({ choices: [{ index: 0, delta: { native: {
    gemini: { content: { role: "model", parts: content } },
  } } }] });
  const output = await restoreNativeStream(upstream(
    frame([tool("Part ", true)]), frame([tool("two", false)], "STOP"), snapshot(parts),
  ), config).text();
  assert.equal(visible(output), "Part two");
  assert.doesNotMatch(output, /functionCall|vertex_deliver_text|"native"/);
  assert.match(output, /data: \[DONE\]/);

  const nativePlain = [{ text: "Ordinary", thoughtSignature: "keep" }];
  const plainOutput = await restoreNativeStream(upstream(
    frame(nativePlain, "STOP"), snapshot(nativePlain),
  ), config).text();
  assert.match(plainOutput, /"native":\{"gemini":/);
  assert.match(plainOutput, /"thoughtSignature":"keep"/);
});

test("tag counting respects nested tags, exemptions and partial closing tags", () => {
  const cut = tagRule({ tag: "A", count: 2, exempt: "skip" });
  assert.equal(cut("<skip><A>ignored</A></skip><A><A>nested</A></A>"), null);
  assert.equal(cut("<A>keep</"), null);
  assert.equal(cut("A>extra"), 2);
});

test("tag stop keeps the closing tag and cancels the source", async () => {
  let cancelled = false;
  const reader = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(encode(frame([tool("<A>正文</", true)]))));
      controller.enqueue(encoder.encode(encode(frame([tool("A>drop", true)]))));
    },
    cancel() { cancelled = true; },
  });
  const response = new Response(reader, { headers: { "content-type": "text/event-stream" } });
  const output = await restoreNativeStream(response, { ...config, tag: "A" }).text();
  assert.equal(visible(output), "<A>正文</A>");
  assert.match(output, /"finishReason":"STOP"/);
  assert.ok(cancelled);
});

test("optional tag stop shows the cut immediately and drains only usage from the same request", async () => {
  let source, calls = 0;
  const encoder = new TextEncoder();
  const send = value => source.enqueue(encoder.encode(encode(value)));
  const reports = [];
  const wrapper = vertexFetch(async () => {
    calls++;
    return new Response(new ReadableStream({ start(controller) { source = controller; } }), {
      headers: { "content-type": "text/event-stream" },
    });
  }, () => ({ ...config, tag: "A", waitForStopUsage: true }), undefined, origin, record => reports.push(record));
  const response = await wrapper(route, { method: "POST", body: JSON.stringify(request) });
  const reader = response.body.getReader();
  send(frame([tool("<A>保留</A>尾巴", true)]));
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.equal(visible(first), "<A>保留</A>");
  assert.doesNotMatch(first, /STOP|\[DONE\]/);
  const usageMetadata = { promptTokenCount: 17, candidatesTokenCount: 20, totalTokenCount: 37 };
  send({ ...frame([tool("还在生成", false)], "MAX_TOKENS"), usageMetadata });
  send({ choices: [{ delta: { native: { gemini: { content: { parts: [{ text: "隐藏历史" }] } } } } }] });
  send("[DONE]");
  let tail = "";
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) tail += new TextDecoder().decode(chunk.value);
  assert.equal(visible(tail), "");
  assert.doesNotMatch(tail, /还在生成|隐藏历史|"native"/);
  assert.deepEqual(JSON.parse(tail.split("\n")[0].slice(6)), { usageMetadata });
  assert.match(tail, /"finishReason":"STOP"[\s\S]*\[DONE\]/);
  assert.equal(calls, 1);
  assert.equal(reports.at(-1).outcome, "tag-stop");
  assert.equal(reports.at(-1).usageAfterTag, true);
  assert.equal(reports.at(-1).finishReason, "MAX_TOKENS");
});

test("recent-request diagnostics report attempts and first text without recording payloads or error text", async () => {
  let calls = 0;
  const reports = [];
  const wrapper = vertexFetch(async () => {
    if (++calls === 1) return upstream({ error: { code: 429, message: "private upstream message" } });
    return upstream(frame([tool("private reply", false)], "STOP"));
  }, () => ({ ...config, retryCount: 1, retrySeconds: 0 }), undefined, origin, record => reports.push(record));
  const run = input => wrapper(route, { method: "POST", headers: { Authorization: "Bearer private-key" }, body: JSON.stringify(input) });
  const response = await run({ ...request, messages: [{ role: "user", content: "private prompt" }] });
  await response.text();
  const record = reports.at(-1);
  assert.equal(record.outcome, "finished");
  assert.equal(record.finishReason, "STOP");
  assert.ok(Number.isInteger(record.firstTextMs));
  assert.deepEqual(record.events.map(item => item.stage), ["request", "http", "upstream-error", "retry", "request", "http", "text", "end"]);
  assert.deepEqual(record.events.filter(item => item.stage === "retry").map(({ status, attempt, waitMs }) => [status, attempt, waitMs]), [[429, 1, 0]]);
  assert.doesNotMatch(JSON.stringify(reports), /private|Bearer/);
  await run({ ...request, enable_web_search: true });
  assert.equal(reports.at(-1).outcome, "native-passthrough");
  assert.equal(reports.at(-1).request, 2);
});

test("missing terminal, unresolved continuation and malformed call remain errors", async () => {
  for (const reason of [undefined, "CONTINUATION", "MALFORMED_FUNCTION_CALL", "STOP"]) {
    const output = await restoreNativeStream(upstream(frame([tool("partial", true)], reason)), config).text();
    assert.match(output, /"error":/);
    if (reason === undefined) assert.equal(visible(output), "partial");
  }
});

test("Google length and filter statuses pass through", async () => {
  for (const reason of ["MAX_TOKENS", "SAFETY"]) {
    const output = await restoreNativeStream(upstream(frame([tool("partial", true)], reason)), config).text();
    assert.ok(output.includes(reason));
    assert.doesNotMatch(output, /"error":/);
  }
});

test("a complete final event without a blank separator still delivers finish and usage", async () => {
  const usageMetadata = { candidatesTokenCount: 5, totalTokenCount: 11 };
  const response = new Response(encode(frame([tool("正文", true)])) +
    `data: ${JSON.stringify({ ...frame([tool("完成", false)], "STOP"), usageMetadata })}`,
  { headers: { "content-type": "text/event-stream" } });
  const output = await restoreNativeStream(response, config).text();
  assert.equal(visible(output), "正文完成");
  assert.match(output, /"finishReason":"STOP"/);
  assert.match(output, /"totalTokenCount":11/);
  assert.doesNotMatch(output, /"error":/);
});
