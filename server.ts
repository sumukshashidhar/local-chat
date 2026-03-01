import Anthropic from "@anthropic-ai/sdk";
import { appendFile, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// ── Config ──────────────────────────────────────────────────────────────────

const PORT = 3000;
const LOGS_DIR = "./logs";
const CHATS_DIR = `${LOGS_DIR}/chats`;
const CHAT_LOGS_JSONL = `${LOGS_DIR}/chat_logs.jsonl`;
const CACHE_TTL = "1h" as const;

const MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-5-20251101",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5-20250929",
] as const;

type Model = (typeof MODELS)[number];
const VALID_MODELS = new Set<string>(MODELS);
const CHAT_ID_RE = /^[a-zA-Z0-9-]+$/;

// ── Providers ──────────────────────────────────────────────────────────────

type Provider = "anthropic" | "openrouter";

const clients: Partial<Record<Provider, Anthropic>> = {};

if (process.env.ANTHROPIC_API_KEY) {
  clients.anthropic = new Anthropic();
}

if (process.env.OPENROUTER_API_KEY) {
  clients.openrouter = new Anthropic({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api",
    defaultHeaders: {
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "Local Chat",
    },
  });
}

const AVAILABLE_PROVIDERS = Object.keys(clients) as Provider[];

if (AVAILABLE_PROVIDERS.length === 0) {
  console.error("No API keys configured. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY.");
  process.exit(1);
}

function getClient(provider: Provider): Anthropic {
  const c = clients[provider];
  if (!c) throw new Error(`Provider "${provider}" is not configured`);
  return c;
}

// ── Types ───────────────────────────────────────────────────────────────────

type Message = { role: "user" | "assistant"; content: string };

interface ChatRequest {
  provider: Provider;
  model: Model;
  system: string;
  messages: Message[];
  session_id: string;
  thinking?: { enabled: boolean; budget_tokens?: number };
}

interface SavedChat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt: string;
  thinkingEnabled: boolean;
  messages: Message[];
}

interface ChatLog {
  id: string;
  session_id: string;
  timestamp: string;
  model: string;
  system_prompt: string;
  messages: Message[];
  response: string;
  thinking_content?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  latency: {
    time_to_first_token_ms: number;
    total_time_ms: number;
    time_to_first_thinking_ms?: number;
  };
  thinking_enabled?: boolean;
  thinking_budget?: number;
  error?: string;
}

// ── Response Helpers ────────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorResponse(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

function notFound(what = "Not found"): Response {
  return errorResponse(what, 404);
}

// ── Concurrency ─────────────────────────────────────────────────────────────

class Mutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return () => this.release();
  }

  private release() {
    const next = this.waiters.shift();
    if (next) next();
    else this.locked = false;
  }
}

const chatLogsMutex = new Mutex();
const chatMutexes = new Map<string, Mutex>();

function mutexFor(chatId: string): Mutex {
  let m = chatMutexes.get(chatId);
  if (!m) {
    m = new Mutex();
    chatMutexes.set(chatId, m);
  }
  return m;
}

// ── File I/O ────────────────────────────────────────────────────────────────

async function atomicWrite(filePath: string, data: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${crypto.randomUUID()}`;
  await writeFile(tmp, data, "utf8");
  try {
    await rename(tmp, filePath);
  } catch {
    try { await unlink(filePath); } catch { /* missing is fine */ }
    await rename(tmp, filePath);
  }
}

async function appendLog(log: ChatLog): Promise<void> {
  const release = await chatLogsMutex.acquire();
  try {
    await appendFile(CHAT_LOGS_JSONL, JSON.stringify(log) + "\n", "utf8");
  } finally {
    release();
  }
}

function chatPath(id: string): string {
  return `${CHATS_DIR}/${id}.json`;
}

async function readChat(id: string): Promise<SavedChat | null> {
  const file = Bun.file(chatPath(id));
  if (!(await file.exists())) return null;
  try { return await file.json(); } catch { return null; }
}

// ── Validation ──────────────────────────────────────────────────────────────

function validateChatId(id: string): string | null {
  return CHAT_ID_RE.test(id) ? null : "Invalid chat ID";
}

function validateChatRequest(body: unknown):
  | { ok: true; data: ChatRequest }
  | { ok: false; error: string } {

  if (!body || typeof body !== "object") {
    return { ok: false, error: "Invalid request body" };
  }

  const b = body as Record<string, unknown>;

  // Provider defaults to first available
  const provider = (typeof b.provider === "string" ? b.provider : AVAILABLE_PROVIDERS[0]) as Provider;
  if (!clients[provider]) {
    return { ok: false, error: `Provider "${provider}" is not available. Available: ${AVAILABLE_PROVIDERS.join(", ")}` };
  }

  if (!b.model || !VALID_MODELS.has(b.model as string)) {
    return { ok: false, error: `Invalid model. Must be one of: ${MODELS.join(", ")}` };
  }
  if (b.system !== undefined && typeof b.system !== "string") {
    return { ok: false, error: "System prompt must be a string" };
  }
  if (!b.session_id || typeof b.session_id !== "string") {
    return { ok: false, error: "session_id is required" };
  }
  if (!Array.isArray(b.messages)) {
    return { ok: false, error: "Messages must be an array" };
  }

  for (const msg of b.messages) {
    if (!msg || typeof msg !== "object") {
      return { ok: false, error: "Each message must be an object" };
    }
    if (msg.role !== "user" && msg.role !== "assistant") {
      return { ok: false, error: "Message role must be 'user' or 'assistant'" };
    }
    if (typeof msg.content !== "string") {
      return { ok: false, error: "Message content must be a string" };
    }
  }

  let thinking: ChatRequest["thinking"];
  if (b.thinking !== undefined) {
    if (typeof b.thinking !== "object" || b.thinking === null) {
      return { ok: false, error: "thinking must be an object" };
    }
    const t = b.thinking as Record<string, unknown>;
    if (typeof t.enabled !== "boolean") {
      return { ok: false, error: "thinking.enabled must be a boolean" };
    }
    if (t.budget_tokens !== undefined && (typeof t.budget_tokens !== "number" || t.budget_tokens < 1024)) {
      return { ok: false, error: "thinking.budget_tokens must be a number >= 1024" };
    }
    thinking = { enabled: t.enabled, budget_tokens: t.budget_tokens as number | undefined };
  }

  return {
    ok: true,
    data: {
      provider,
      model: b.model as Model,
      system: (b.system as string) || "",
      messages: b.messages as Message[],
      session_id: b.session_id as string,
      thinking,
    },
  };
}

// ── Handlers: Chat Streaming ────────────────────────────────────────────────

async function handleStream(req: Request): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch {
    return errorResponse("Invalid JSON");
  }

  const v = validateChatRequest(body);
  if (!v.ok) return errorResponse(v.error);

  const { provider, model, system, messages, session_id, thinking } = v.data;
  const client = getClient(provider);
  const logId = crypto.randomUUID();
  const t0 = performance.now();
  let ttft: number | null = null;
  let ttfThinking: number | null = null;
  let fullResponse = "";
  let fullThinking = "";

  // System content with prompt caching
  const systemContent: Anthropic.TextBlockParam[] = system
    ? [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: CACHE_TTL } }]
    : [];

  // Messages with cache control on conversation prefix
  const formatted: Anthropic.MessageParam[] = messages.map((m, i) => ({
    role: m.role,
    content: [{
      type: "text" as const,
      text: m.content,
      ...(i === messages.length - 2 && { cache_control: { type: "ephemeral" as const, ttl: CACHE_TTL } }),
    }],
  }));

  const thinkingCfg = thinking?.enabled
    ? { type: "enabled" as const, budget_tokens: thinking.budget_tokens ?? 10000 }
    : undefined;

  const stream = await client.beta.messages.stream({
    model,
    max_tokens: thinking?.enabled ? 32000 : 8192,
    system: systemContent,
    messages: formatted,
    ...(thinkingCfg && { thinking: thinkingCfg }),
    betas: ["extended-cache-ttl-2025-04-11"],
  });

  const encoder = new TextEncoder();
  const sse = (obj: Record<string, unknown>) =>
    encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);

  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (event.type !== "content_block_delta" && event.type !== "message_stop") continue;

          if (event.type === "content_block_delta") {
            if (event.delta.type === "thinking_delta") {
              ttfThinking ??= performance.now() - t0;
              fullThinking += event.delta.thinking;
              controller.enqueue(sse({ type: "thinking_delta", thinking: event.delta.thinking }));
            } else if (event.delta.type === "text_delta") {
              ttft ??= performance.now() - t0;
              fullResponse += event.delta.text;
              controller.enqueue(sse({ type: "delta", text: event.delta.text }));
            }
          } else {
            const final = await stream.finalMessage();
            const elapsed = performance.now() - t0;
            const usage = final.usage as Record<string, unknown>;

            appendLog({
              id: logId,
              session_id,
              timestamp: new Date().toISOString(),
              model,
              system_prompt: system,
              messages,
              response: fullResponse,
              thinking_content: fullThinking || undefined,
              usage: {
                input_tokens: final.usage.input_tokens,
                output_tokens: final.usage.output_tokens,
                cache_creation_input_tokens: usage.cache_creation_input_tokens as number | undefined,
                cache_read_input_tokens: usage.cache_read_input_tokens as number | undefined,
              },
              latency: {
                time_to_first_token_ms: Math.round(ttft ?? elapsed),
                total_time_ms: Math.round(elapsed),
                time_to_first_thinking_ms: ttfThinking ? Math.round(ttfThinking) : undefined,
              },
              thinking_enabled: thinking?.enabled,
              thinking_budget: thinking?.budget_tokens,
            }).catch(console.error);

            controller.enqueue(sse({ type: "done", usage: final.usage }));
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        const elapsed = performance.now() - t0;

        appendLog({
          id: logId,
          session_id,
          timestamp: new Date().toISOString(),
          model,
          system_prompt: system,
          messages,
          response: fullResponse,
          thinking_content: fullThinking || undefined,
          usage: { input_tokens: 0, output_tokens: 0 },
          latency: {
            time_to_first_token_ms: Math.round(ttft ?? elapsed),
            total_time_ms: Math.round(elapsed),
            time_to_first_thinking_ms: ttfThinking ? Math.round(ttfThinking) : undefined,
          },
          thinking_enabled: thinking?.enabled,
          thinking_budget: thinking?.budget_tokens,
          error: msg,
        }).catch(console.error);

        controller.enqueue(sse({ type: "error", error: msg }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

// ── Handlers: Chat CRUD ─────────────────────────────────────────────────────

async function handleListChats(): Promise<Response> {
  const files = await readdir(CHATS_DIR);
  const chats = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const data: SavedChat = await Bun.file(`${CHATS_DIR}/${file}`).json();
      const firstUser = data.messages.find((m) => m.role === "user");
      chats.push({
        id: data.id,
        title: data.title,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        messageCount: data.messages.length,
        preview: firstUser?.content.slice(0, 100) || "",
      });
    } catch { /* skip corrupt files */ }
  }

  chats.sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
  return jsonResponse({ chats });
}

async function handleGetChat(id: string): Promise<Response> {
  const err = validateChatId(id);
  if (err) return errorResponse(err);

  const chat = await readChat(id);
  return chat ? jsonResponse(chat) : notFound("Chat not found");
}

async function handleSaveChat(req: Request): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch {
    return errorResponse("Invalid JSON");
  }

  const b = body as Record<string, unknown>;

  if (!b.sessionId || typeof b.sessionId !== "string") {
    return errorResponse("sessionId is required");
  }
  if (!Array.isArray(b.messages)) {
    return errorResponse("messages must be an array");
  }

  const id = (typeof b.id === "string" && CHAT_ID_RE.test(b.id)) ? b.id : crypto.randomUUID();
  const now = new Date().toISOString();

  const release = await mutexFor(id).acquire();
  try {
    const existing = await readChat(id);

    const chat: SavedChat = existing
      ? {
          // Update existing
          ...existing,
          updatedAt: now,
          provider: str(b.provider) || existing.provider,
          model: str(b.model) || existing.model,
          systemPrompt: b.systemPrompt != null ? str(b.systemPrompt) : existing.systemPrompt,
          thinkingEnabled: typeof b.thinkingEnabled === "boolean" ? b.thinkingEnabled : existing.thinkingEnabled,
          messages: b.messages as Message[],
          ...(str(b.title) && { title: str(b.title) }),
        }
      : {
          // New chat
          id,
          title: str(b.title) || autoTitle(b.messages as Message[]),
          createdAt: now,
          updatedAt: now,
          sessionId: b.sessionId as string,
          provider: str(b.provider) || AVAILABLE_PROVIDERS[0],
          model: str(b.model) || "claude-sonnet-4-5-20250929",
          systemPrompt: str(b.systemPrompt) || "",
          thinkingEnabled: typeof b.thinkingEnabled === "boolean" ? b.thinkingEnabled : false,
          messages: b.messages as Message[],
        };

    await atomicWrite(chatPath(id), JSON.stringify(chat, null, 2));

    return jsonResponse({
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
    });
  } finally {
    release();
  }
}

async function handleRenameChat(id: string, req: Request): Promise<Response> {
  const err = validateChatId(id);
  if (err) return errorResponse(err);

  let body: unknown;
  try { body = await req.json(); } catch {
    return errorResponse("Invalid JSON");
  }

  const { title } = body as Record<string, unknown>;
  if (!title || typeof title !== "string") {
    return errorResponse("title is required");
  }

  const release = await mutexFor(id).acquire();
  try {
    const chat = await readChat(id);
    if (!chat) return notFound("Chat not found");

    chat.title = title;
    chat.updatedAt = new Date().toISOString();
    await atomicWrite(chatPath(id), JSON.stringify(chat, null, 2));

    return jsonResponse({ id: chat.id, title: chat.title, updatedAt: chat.updatedAt });
  } finally {
    release();
  }
}

async function handleDeleteChat(id: string): Promise<Response> {
  const err = validateChatId(id);
  if (err) return errorResponse(err);

  const release = await mutexFor(id).acquire();
  try {
    if (!(await Bun.file(chatPath(id)).exists())) {
      return notFound("Chat not found");
    }
    await unlink(chatPath(id));
    return jsonResponse({ success: true });
  } finally {
    release();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function autoTitle(messages: Message[]): string {
  const first = messages[0]?.content || "";
  return first.length > 50 ? first.slice(0, 50) + "..." : first || "New Chat";
}

// ── Static Files ────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
};

const STATIC_CACHE = "no-cache";

async function serveStatic(pathname: string): Promise<Response> {
  const filePath = `./public${pathname === "/" ? "/index.html" : pathname}`;
  const file = Bun.file(filePath);

  if (!(await file.exists())) return notFound();

  const ext = filePath.slice(filePath.lastIndexOf("."));
  return new Response(file, {
    headers: {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": STATIC_CACHE,
    },
  });
}

// ── Router ──────────────────────────────────────────────────────────────────

type Handler = (req: Request, params: Record<string, string>) => Promise<Response>;

interface Route {
  method: string;
  pattern: URLPattern;
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  return { method, pattern: new URLPattern({ pathname: path }), handler };
}

const routes: Route[] = [
  route("POST", "/api/chat",       (req) => handleStream(req)),
  route("GET",  "/api/models",     ()    => Promise.resolve(jsonResponse({ models: MODELS, providers: AVAILABLE_PROVIDERS }))),
  route("GET",  "/api/chats",      ()    => handleListChats()),
  route("POST", "/api/chats",      (req) => handleSaveChat(req)),
  route("GET",  "/api/chats/:id",  (_req, p) => handleGetChat(p.id)),
  route("PATCH","/api/chats/:id",  (req, p) => handleRenameChat(p.id, req)),
  route("DELETE","/api/chats/:id", (_req, p) => handleDeleteChat(p.id)),
];

// ── Server ──────────────────────────────────────────────────────────────────

await mkdir(LOGS_DIR, { recursive: true });
await mkdir(CHATS_DIR, { recursive: true });

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const method = req.method;

    for (const r of routes) {
      if (r.method !== method) continue;
      const match = r.pattern.exec(req.url);
      if (!match) continue;
      return r.handler(req, (match.pathname.groups || {}) as Record<string, string>);
    }

    // Fall through to static files
    return serveStatic(new URL(req.url).pathname);
  },
});

console.log(`Server running at http://localhost:${server.port}`);
