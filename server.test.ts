import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { langfuseCostDetails, langfuseUsageDetails } from "./langfuse";

let BASE_URL = process.env.TEST_BASE_URL || "";
let appProcess: ReturnType<typeof Bun.spawn> | null = null;
let mockOpenRouter: ReturnType<typeof Bun.serve> | null = null;
let mockLangfuse: ReturnType<typeof Bun.serve> | null = null;
let testRoot = "";
let testLogsDir = "";
let mockOpenRouterCancelCount = 0;
const langfuseExports: Array<{
  auth: string | null;
  contentType: string | null;
  body: Uint8Array;
  searchableText: string;
  json: Record<string, unknown>;
}> = [];
const openRouterChatBodies: Array<Record<string, unknown>> = [];

function randomPort(): number {
  return 39_000 + Math.floor(Math.random() * 10_000);
}

function sse(data: unknown): string {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

function startMockOpenRouter(): ReturnType<typeof Bun.serve> {
  const encoder = new TextEncoder();

  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/v1/models") {
        return Response.json({
          data: [
            {
              id: "google/gemini-2.0-flash-001",
              name: "Gemini 2.0 Flash",
              description: "Mock model for local tests",
              context_length: 1_048_576,
              supported_parameters: ["reasoning", "include_usage"],
              pricing: {
                prompt: "0.000002",
                completion: "0.000012",
                input_cache_read: "0.0000005",
                input_cache_write: "0.000002",
              },
            },
            {
              id: "moonshotai/kimi-k3",
              name: "MoonshotAI: Kimi K3",
              description: "Mock Kimi K3 for reasoning-effort mapping tests",
              context_length: 1_048_576,
              supported_parameters: [
                "include_reasoning",
                "max_tokens",
                "reasoning",
                "reasoning_effort",
              ],
              reasoning: {
                mandatory: true,
                default_enabled: true,
                supported_efforts: ["max"],
              },
              pricing: {
                prompt: "0.000003",
                completion: "0.000015",
                input_cache_read: "0.0000003",
              },
            },
          ],
        });
      }

      if (url.pathname === "/api/v1/chat/completions") {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>;
        openRouterChatBodies.push(body);
        const bodyText = JSON.stringify(body);

        if (bodyText.includes("idle-timeout")) {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode(": heartbeat\n\n"));
              },
              cancel() {
                mockOpenRouterCancelCount += 1;
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }

        if (bodyText.includes("slow-cancel")) {
          let interval: ReturnType<typeof setInterval> | null = null;
          return new Response(
            new ReadableStream({
              start(controller) {
                let count = 0;
                interval = setInterval(() => {
                  count += 1;
                  controller.enqueue(encoder.encode(sse({
                    choices: [{ delta: { content: `chunk-${count} ` } }],
                  })));
                  if (count >= 50 && interval) {
                    clearInterval(interval);
                    controller.enqueue(encoder.encode(sse("[DONE]")));
                    controller.close();
                  }
                }, 25);
              },
              cancel() {
                mockOpenRouterCancelCount += 1;
                if (interval) clearInterval(interval);
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }

        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(sse({
                choices: [{ delta: { reasoning: "I should answer with OK." } }],
              })));
              controller.enqueue(encoder.encode(sse({
                choices: [{ delta: { content: "OK" } }],
              })));
              controller.enqueue(encoder.encode(sse({
                choices: [],
                usage: {
                  prompt_tokens: 12,
                  completion_tokens: 1,
                  prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
                },
              })));
              controller.enqueue(encoder.encode(sse("[DONE]")));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }

      return new Response("Not found", { status: 404 });
    },
  });
}

function startMockLangfuse(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/api/public/otel/v1/traces") {
        return new Response("Not found", { status: 404 });
      }

      const body = new Uint8Array(await req.arrayBuffer());
      const searchableText = new TextDecoder().decode(body);
      langfuseExports.push({
        auth: req.headers.get("authorization"),
        contentType: req.headers.get("content-type"),
        body,
        searchableText,
        json: JSON.parse(searchableText) as Record<string, unknown>,
      });
      return Response.json({}, {
        status: 200,
      });
    },
  });
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(50);
  }

  throw new Error(`Server did not start: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function waitForCondition(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function getAnyModel(): Promise<string> {
  const geminiRes = await fetch(`${BASE_URL}/api/models?q=google/gemini&limit=1`);
  if (geminiRes.ok) {
    const gemini = await geminiRes.json();
    if (gemini.models?.[0]?.id) return gemini.models[0].id as string;
  }

  const res = await fetch(`${BASE_URL}/api/models?limit=1`);
  if (!res.ok) {
    throw new Error(`Failed to fetch models: ${res.status}`);
  }
  const data = await res.json();
  const id = data.models?.[0]?.id;
  if (!id || typeof id !== "string") {
    throw new Error("No model IDs returned from /api/models");
  }
  return id;
}

beforeAll(async () => {
  if (BASE_URL) return;

  testRoot = await mkdtemp(join(tmpdir(), "local-chat-test-"));
  testLogsDir = join(testRoot, "logs");
  const themesDir = join(testRoot, "themes");
  await mkdir(themesDir, { recursive: true });
  await symlink(join(import.meta.dir, "public"), join(testRoot, "public"), "dir");

  mockOpenRouter = startMockOpenRouter();
  mockLangfuse = startMockLangfuse();
  const port = randomPort();
  BASE_URL = `http://127.0.0.1:${port}`;
  await writeFile(
    join(testRoot, ".env"),
    [
      "OPENROUTER_API_KEY=test-key",
      `OPENROUTER_API_BASE=${mockOpenRouter.url.origin}/api/v1`,
      "OPENROUTER_CONNECT_TIMEOUT_MS=120",
      "OPENROUTER_STREAM_IDLE_TIMEOUT_MS=120",
      "LANGFUSE_ENABLED=1",
      "LANGFUSE_PUBLIC_KEY=pk-test",
      "LANGFUSE_SECRET_KEY=sk-test",
      `LANGFUSE_BASE_URL=${mockLangfuse.url.origin}`,
      "",
    ].join("\n"),
    "utf8",
  );

  const appEnv = { ...process.env };
  appEnv.OPENROUTER_API_KEY = "wrong-global-key";
  appEnv.OPENROUTER_API_BASE = "http://127.0.0.1:9/api/v1";
  appEnv.LANGFUSE_ENABLED = "0";
  appEnv.LANGFUSE_PUBLIC_KEY = "wrong-global-public-key";
  appEnv.LANGFUSE_SECRET_KEY = "wrong-global-secret-key";
  appEnv.LANGFUSE_BASE_URL = "http://127.0.0.1:9";

  appProcess = Bun.spawn({
    cmd: ["bun", "run", join(import.meta.dir, "server.ts")],
    cwd: testRoot,
    env: {
      ...appEnv,
      PORT: String(port),
      LOGS_DIR: testLogsDir,
      OBSIDIAN_THEMES_DIR: themesDir,
      LOG_LEVEL: "silent",
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  await waitForServer(`${BASE_URL}/`);
}, 10_000);

afterAll(async () => {
  if (appProcess) {
    appProcess.kill();
    await appProcess.exited.catch(() => undefined);
  }
  mockOpenRouter?.stop(true);
  mockLangfuse?.stop(true);
  if (testRoot) {
    await rm(testRoot, { recursive: true, force: true });
  }
});

describe("Chat API", () => {
  test("Langfuse usage details use mutually exclusive cache buckets", () => {
    expect(langfuseUsageDetails({
      input_tokens: 12,
      output_tokens: 1,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 2,
    })).toEqual({
      input: 6,
      output: 1,
      total: 13,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 2,
    });
  });

  test("GET /api/models returns OpenRouter model catalog", async () => {
    const res = await fetch(`${BASE_URL}/api/models`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("openrouter");
    expect(Array.isArray(data.models)).toBe(true);
    expect(data.models.length).toBeGreaterThan(0);
    expect(data.models[0].id).toBe("google/gemini-2.0-flash-001");
    expect(data.models[0].pricing.input_cache_read).toBe("0.0000005");
    expect(data.models[0].pricing.input_cache_write).toBe("0.000002");
  });

  test("GET /api/themes returns theme metadata", async () => {
    const res = await fetch(`${BASE_URL}/api/themes`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.source).toBe("obsidian");
    expect(Array.isArray(data.themes)).toBe(true);
  });

  test("GET / serves index.html", async () => {
    const res = await fetch(`${BASE_URL}/`);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(text).toContain("<!DOCTYPE html>");
  });

  test("GET /styles.css serves CSS", async () => {
    const res = await fetch(`${BASE_URL}/styles.css`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("GET path traversal is blocked", async () => {
    const res = await fetch(`${BASE_URL}/..%2Fserver.ts`);
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.error).toBe("Not found");
  });

  test("POST /api/chat streams response and writes a structured chat log", async () => {
    langfuseExports.length = 0;
    const model = await getAnyModel();
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        system: "You are a helpful assistant. Respond with exactly: OK",
        messages: [{ role: "user", content: "Test" }],
        session_id: "test-session-123",
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("x-request-id")).toBeTruthy();

    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const eventTypes: string[] = [];
    let doneEvent: Record<string, any> | null = null;

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const event of events) {
          const payload = event
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
          if (!payload) continue;
          const data = JSON.parse(payload);
          eventTypes.push(data.type);
          if (data.type === "done") doneEvent = data;
        }
      }
    }

    expect(eventTypes).toContain("delta");
    expect(eventTypes).toContain("done");

    // The done event carries usage (incl. cached tokens) and latency so the
    // client can render the per-message cost/usage readout.
    expect(doneEvent).toBeTruthy();
    expect(doneEvent?.usage.input_tokens).toBe(12);
    expect(doneEvent?.usage.output_tokens).toBe(1);
    expect(doneEvent?.usage.cache_read_input_tokens).toBe(4);
    expect(doneEvent?.usage.cache_creation_input_tokens).toBe(2);
    expect(typeof doneEvent?.latency?.total_time_ms).toBe("number");
    expect(doneEvent?.latency?.total_time_ms).toBeGreaterThanOrEqual(0);
    expect(typeof doneEvent?.latency?.time_to_first_token_ms).toBe("number");

    if (testLogsDir) {
      const logText = await readFile(join(testLogsDir, "chat_logs.jsonl"), "utf8");
      const lastLog = JSON.parse(logText.trim().split("\n").at(-1) || "{}");
      expect(lastLog.status).toBe("completed");
      expect(lastLog.provider).toBe("openrouter");
      expect(lastLog.request_id).toBeTruthy();
      expect(lastLog.response).toBe("OK");
      expect(lastLog.thinking_content).toBe("I should answer with OK.");
      expect(lastLog.usage.input_tokens).toBe(12);
      expect(lastLog.usage.output_tokens).toBe(1);
      expect(lastLog.usage.cache_creation_input_tokens).toBe(2);
    }

    await waitForCondition(() => langfuseExports.length > 0, "Langfuse OTLP export");
    const lastExport = langfuseExports.at(-1);
    expect(lastExport?.auth).toBe(`Basic ${btoa("pk-test:sk-test")}`);
    expect(lastExport?.contentType).toContain("application/json");
    expect(lastExport?.body.byteLength).toBeGreaterThan(0);
    expect(Array.isArray(lastExport?.json.resourceSpans)).toBe(true);
    expect(lastExport?.searchableText).toContain("chat.request");
    expect(lastExport?.searchableText).toContain("openrouter.chat.completions");
    expect(lastExport?.searchableText).toContain("test-session-123");
    expect(lastExport?.searchableText).toContain(model);
    expect(lastExport?.searchableText).toContain("cache_creation_input_tokens");
    expect(lastExport?.searchableText).toContain("I should answer with OK.");
  });

  test("POST /api/chat accepts a conversation ending with an assistant turn (continuation)", async () => {
    const model = await getAnyModel();
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        system: "You are a helpful assistant.",
        // Conversation ends on an assistant turn — the prefill the model
        // should continue. The server must not reject this.
        messages: [
          { role: "user", content: "Write a numbered list." },
          { role: "assistant", content: "Here is the list:\n1." },
        ],
        session_id: "test-continue-1",
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const eventTypes: string[] = [];
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const event of events) {
          const payload = event
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
          if (!payload) continue;
          eventTypes.push(JSON.parse(payload).type);
        }
      }
    }

    expect(eventTypes).toContain("delta");
    expect(eventTypes).toContain("done");
  });

  test("POST /api/chat records cancellation when the client aborts mid-stream", async () => {
    const model = await getAnyModel();
    const controller = new AbortController();
    const sessionId = `cancel-session-${Date.now()}`;

    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        system: "",
        messages: [{ role: "user", content: "slow-cancel" }],
        session_id: sessionId,
      }),
    });

    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    expect(reader).toBeTruthy();

    const decoder = new TextDecoder();
    let buffer = "";
    while (!buffer.includes("\"type\":\"delta\"")) {
      const chunk = await reader!.read();
      expect(chunk.done).toBe(false);
      buffer += decoder.decode(chunk.value, { stream: true });
    }

    controller.abort();
    await reader!.read().catch(() => undefined);

    await waitForCondition(async () => {
      const logText = await readFile(join(testLogsDir, "chat_logs.jsonl"), "utf8").catch(() => "");
      return logText
        .trim()
        .split("\n")
        .filter(Boolean)
        .some((line) => {
          const log = JSON.parse(line) as Record<string, unknown>;
          return (
            log.session_id === sessionId &&
            log.status === "cancelled" &&
            typeof log.response === "string" &&
            log.response.includes("chunk-")
          );
        });
    }, "cancelled stream log");
  });

  test("POST /api/chat records stalled upstream streams as timeout failures", async () => {
    const model = await getAnyModel();
    const sessionId = `idle-timeout-session-${Date.now()}`;

    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        system: "",
        messages: [{ role: "user", content: "idle-timeout" }],
        session_id: sessionId,
      }),
    });

    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    expect(reader).toBeTruthy();

    const decoder = new TextDecoder();
    let buffer = "";
    let errorEvent: Record<string, unknown> | null = null;

    while (!errorEvent) {
      const chunk = await Promise.race([
        reader!.read(),
        Bun.sleep(2_000).then(() => {
          throw new Error("Timed out waiting for stalled stream error event");
        }),
      ]);
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const event of events) {
        const payload = event
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        if (!payload) continue;
        const data = JSON.parse(payload) as Record<string, unknown>;
        if (data.type === "error") {
          errorEvent = data;
          break;
        }
      }
    }

    expect(errorEvent?.error).toContain("OpenRouter stream timed out");

    await waitForCondition(async () => {
      const logText = await readFile(join(testLogsDir, "chat_logs.jsonl"), "utf8").catch(() => "");
      return logText
        .trim()
        .split("\n")
        .filter(Boolean)
        .some((line) => {
          const log = JSON.parse(line) as Record<string, unknown>;
          return (
            log.session_id === sessionId &&
            log.status === "failed" &&
            typeof log.error === "string" &&
            log.error.includes("OpenRouter stream timed out")
          );
        });
    }, "stalled stream timeout log");
  });

  test("POST /api/chats/:id/duplicate creates an independent chat copy", async () => {
    const model = await getAnyModel();
    const saveRes = await fetch(`${BASE_URL}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Duplicate me",
        sessionId: "duplicate-source-session",
        provider: "openrouter",
        model,
        systemPrompt: "Be brief",
        thinkingEnabled: true,
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi" },
        ],
      }),
    });
    expect(saveRes.status).toBe(200);
    const saved = await saveRes.json();

    const duplicateRes = await fetch(`${BASE_URL}/api/chats/${saved.id}/duplicate`, {
      method: "POST",
    });
    expect(duplicateRes.status).toBe(200);
    const duplicate = await duplicateRes.json();

    expect(duplicate.id).not.toBe(saved.id);
    expect(duplicate.title).toBe("Duplicate me (copy)");
    expect(duplicate.sessionId).not.toBe("duplicate-source-session");
    expect(duplicate.model).toBe(model);
    expect(duplicate.systemPrompt).toBe("Be brief");
    expect(duplicate.thinkingEnabled).toBe(true);
    expect(duplicate.messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ]);

    const getDuplicateRes = await fetch(`${BASE_URL}/api/chats/${duplicate.id}`);
    expect(getDuplicateRes.status).toBe(200);
  });

  test("POST /api/chat sends xhigh reasoning effort for thinking requests", async () => {
    const model = await getAnyModel();
    openRouterChatBodies.length = 0;

    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        system: "",
        messages: [{ role: "user", content: "Budget test" }],
        session_id: "test-thinking-budget",
        thinking: { enabled: true, budget_tokens: 2048 },
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const upstream = openRouterChatBodies.at(-1);
    expect(upstream).toBeTruthy();
    // OpenRouter maps reasoning.effort across model families; keep thinking
    // uniformly maximal even when old clients still send a token budget.
    expect(upstream?.reasoning).toEqual({ effort: "xhigh" });
    expect(upstream?.provider).toEqual({ require_parameters: true });
    expect(upstream?.max_tokens).toBe(32000);
  });

  test("POST /api/chat maps Gemini 3 thinking budgets to reasoning effort", async () => {
    openRouterChatBodies.length = 0;

    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3.1-pro-preview",
        system: "",
        messages: [{ role: "user", content: "Gemini thinking test" }],
        session_id: "test-gemini-thinking",
        thinking: { enabled: true, budget_tokens: 10_000 },
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const upstream = openRouterChatBodies.at(-1);
    expect(upstream).toBeTruthy();
    expect(upstream?.reasoning).toEqual({ effort: "xhigh" });
    expect(upstream?.provider).toEqual({ require_parameters: true });
    expect(upstream?.max_tokens).toBe(32000);
  });

  test("POST /api/chat maps Kimi K3 thinking to effort max only", async () => {
    openRouterChatBodies.length = 0;

    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "moonshotai/kimi-k3",
        system: "",
        messages: [{ role: "user", content: "Kimi K3 thinking test" }],
        session_id: "test-kimi-k3-thinking",
        thinking: { enabled: true },
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const upstream = openRouterChatBodies.at(-1);
    expect(upstream).toBeTruthy();
    // K3 only accepts "max"; "xhigh" + require_parameters is invalid for this model.
    expect(upstream?.reasoning).toEqual({ effort: "max" });
    expect(upstream?.provider).toEqual({ require_parameters: true });
    expect(upstream?.max_tokens).toBe(65_536);
  });

  test("POST /api/chat always enables reasoning for mandatory reasoners", async () => {
    openRouterChatBodies.length = 0;

    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "moonshotai/kimi-k3",
        system: "",
        messages: [{ role: "user", content: "Kimi K3 no UI think toggle" }],
        session_id: "test-kimi-k3-mandatory",
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const upstream = openRouterChatBodies.at(-1);
    expect(upstream).toBeTruthy();
    expect(upstream?.reasoning).toEqual({ effort: "max" });
    expect(upstream?.max_tokens).toBe(65_536);
  });

  test("POST /api/chat replays assistant thinking for multi-turn Kimi K3", async () => {
    openRouterChatBodies.length = 0;

    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "moonshotai/kimi-k3",
        system: "",
        messages: [
          { role: "user", content: "Remember BLUE42" },
          {
            role: "assistant",
            content: "OK",
            thinking: "User asked me to remember BLUE42; reply OK.",
          },
          { role: "user", content: "What was the code?" },
        ],
        session_id: "test-kimi-k3-replay",
        thinking: { enabled: true },
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const upstream = openRouterChatBodies.at(-1);
    expect(upstream).toBeTruthy();
    const msgs = upstream?.messages as Array<Record<string, unknown>>;
    expect(Array.isArray(msgs)).toBe(true);
    const assistant = msgs.find((m) => m.role === "assistant");
    expect(assistant).toBeTruthy();
    expect(assistant?.reasoning).toBe("User asked me to remember BLUE42; reply OK.");
    expect(assistant?.reasoning_content).toBe("User asked me to remember BLUE42; reply OK.");
  });

  test("POST /api/chat strips trailing empty assistant placeholder (Moonshot empty text)", async () => {
    openRouterChatBodies.length = 0;
    const model = await getAnyModel();

    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        system: "",
        // Client streaming stub: empty assistant after the user turn.
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "" },
        ],
        session_id: "test-empty-assistant-stub",
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const upstream = openRouterChatBodies.at(-1);
    expect(upstream).toBeTruthy();
    const msgs = upstream?.messages as Array<Record<string, unknown>>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe("user");
    const content = msgs[0]?.content as Array<{ type: string; text: string }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]?.text).toBe("Hello");
    expect(content[0]?.text.length).toBeGreaterThan(0);
  });

  test("POST /api/chat never sends empty text parts for thinking-only assistant turns", async () => {
    openRouterChatBodies.length = 0;

    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "moonshotai/kimi-k3",
        system: "",
        messages: [
          { role: "user", content: "Think then answer" },
          {
            role: "assistant",
            content: "",
            thinking: "I started reasoning but output was interrupted.",
          },
          { role: "user", content: "Continue" },
        ],
        session_id: "test-thinking-only-empty-content",
        thinking: { enabled: true },
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const upstream = openRouterChatBodies.at(-1);
    const msgs = upstream?.messages as Array<Record<string, unknown>>;
    expect(Array.isArray(msgs)).toBe(true);
    for (const msg of msgs) {
      const parts = msg.content as Array<{ type?: string; text?: string }>;
      expect(Array.isArray(parts)).toBe(true);
      for (const part of parts) {
        if (part?.type === "text") {
          expect(typeof part.text).toBe("string");
          expect((part.text || "").length).toBeGreaterThan(0);
        }
      }
    }
    const assistant = msgs.find((m) => m.role === "assistant");
    expect(assistant?.reasoning).toBe("I started reasoning but output was interrupted.");
  });

  test("POST /api/chat sends no reasoning config when thinking is off", async () => {
    const model = await getAnyModel();
    openRouterChatBodies.length = 0;

    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        system: "",
        messages: [{ role: "user", content: "No thinking" }],
        session_id: "test-no-thinking",
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const upstream = openRouterChatBodies.at(-1);
    expect(upstream).toBeTruthy();
    expect(upstream?.reasoning).toBeUndefined();
    expect(upstream?.provider).toBeUndefined();
    expect(upstream?.max_tokens).toBe(8192);
  });

  test("POST /api/chat returns 400 for missing model", async () => {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "",
        system: "",
        messages: [{ role: "user", content: "Test" }],
        session_id: "test-session-123",
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("model is required");
  });

  test("POST /api/chat returns 400 for invalid messages", async () => {
    const model = await getAnyModel();
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        system: "",
        messages: "not an array",
        session_id: "test-session-123",
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Messages must be an array");
  });

  test("POST /api/chat returns 400 for missing session_id", async () => {
    const model = await getAnyModel();
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        system: "",
        messages: [{ role: "user", content: "Test" }],
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("session_id is required");
  });

  test("POST /api/chat returns 400 for invalid JSON", async () => {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid JSON");
  });

  test("POST /api/chat rejects an invalid interaction kind", async () => {
    const model = await getAnyModel();
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        system: "",
        messages: [{ role: "user", content: "Test" }],
        session_id: "test-interaction-invalid",
        interaction: { kind: "time-travel" },
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("interaction.kind");
  });

  test("forked turns (retry) export fork lineage to Langfuse with cost details", async () => {
    langfuseExports.length = 0;
    const model = await getAnyModel();
    const sessionId = `fork-session-${Date.now()}`;

    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        system: "You are a helpful assistant.",
        messages: [
          { role: "user", content: "First attempt prompt" },
          { role: "assistant", content: "First attempt answer" },
        ],
        session_id: sessionId,
        // Retry fork: fresh sibling of the first assistant reply.
        interaction: {
          kind: "retry",
          chat_id: "0f0f0f0f-1111-4222-8333-444455556666",
          assistant_node_id: "n-fork-new",
          branched_from_node_id: "n-fork-old",
          sibling_index: 2,
          sibling_count: 2,
          path_length: 4,
        },
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    await waitForCondition(() => langfuseExports.length > 0, "Langfuse OTLP export");
    const lastExport = langfuseExports.at(-1);
    const text = lastExport?.searchableText || "";

    expect(text).toContain(sessionId);
    expect(text).toContain("interaction_kind");
    expect(text).toContain("n-fork-old");
    expect(text).toContain("n-fork-new");
    expect(text).toContain("fork-retry");
    expect(text).toContain("0f0f0f0f-1111-4222-8333-444455556666");
  });
});

describe("Langfuse cost details", () => {
  const pricing = {
    prompt: 0.000002,
    completion: 0.000012,
    input_cache_read: 0.0000005,
    input_cache_write: 0.000002,
  };

  test("computes cache-aware USD costs", () => {
    const details = langfuseCostDetails(pricing, {
      input_tokens: 12,
      output_tokens: 1,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 2,
    });
    // 6 uncached input tokens + 4 cache-read + 2 cache-write + 1 output.
    expect(details?.input).toBeCloseTo(0.000018, 12);
    expect(details?.output).toBeCloseTo(0.000012, 12);
    expect(details?.total).toBeCloseTo(0.00003, 12);
  });

  test("falls back to the base prompt rate when cache rates are missing", () => {
    const details = langfuseCostDetails(
      { prompt: 0.000001, completion: 0.000002 },
      {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 4,
      },
    );
    // All 10 input tokens bill at the base rate.
    expect(details?.input).toBeCloseTo(0.00001, 12);
    expect(details?.output).toBeCloseTo(0.00001, 12);
    expect(details?.total).toBeCloseTo(0.00002, 12);
  });

  test("returns undefined when no pricing is available", () => {
    expect(langfuseCostDetails(undefined, {
      input_tokens: 10,
      output_tokens: 5,
    })).toBeUndefined();
  });
});
