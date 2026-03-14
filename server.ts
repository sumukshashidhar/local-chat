import { appendFile, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// ── Config ──────────────────────────────────────────────────────────────────

const PORT = Number.parseInt(process.env.PORT || "3000", 10) || 3000;
const LOGS_DIR = "./logs";
const CHATS_DIR = `${LOGS_DIR}/chats`;
const CHAT_LOGS_JSONL = `${LOGS_DIR}/chat_logs.jsonl`;
const MODEL_CACHE_JSON = `${LOGS_DIR}/openrouter_models_cache.json`;
const PROMPT_CACHE_TTL = "1h" as const;
const DEFAULT_MODEL = process.env.OPENROUTER_DEFAULT_MODEL || "google/gemini-2.0-flash-001";
const OPENROUTER_PROVIDER = "openrouter" as const;
const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_CHAT_URL = `${OPENROUTER_API_BASE}/chat/completions`;
const OPENROUTER_MODELS_URL = `${OPENROUTER_API_BASE}/models`;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const THEME_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_OBSIDIAN_THEMES_DIR = "/Users/sumukshashidhar/Documents/root/resources/reflection/.obsidian/themes";
const OBSIDIAN_THEMES_DIR = process.env.OBSIDIAN_THEMES_DIR || DEFAULT_OBSIDIAN_THEMES_DIR;
const CHAT_ID_RE = /^[a-zA-Z0-9-]+$/;
const THEME_ID_RE = /^[a-z0-9-]+$/;

const openRouterApiKey = process.env.OPENROUTER_API_KEY;
if (!openRouterApiKey) {
  console.error("No API key configured. Set OPENROUTER_API_KEY.");
  process.exit(1);
}

function openRouterHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${openRouterApiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "http://localhost:3000",
    "X-Title": "Local Chat",
  };
}

// ── Types ───────────────────────────────────────────────────────────────────

type Message = { role: "user" | "assistant"; content: string };

interface ChatRequest {
  model: string;
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

interface ModelCatalogEntry {
  id: string;
  name: string;
  description: string;
  context_length?: number;
  supported_parameters?: string[];
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

interface ThemeCatalogEntry {
  id: string;
  name: string;
  cssPath: string;
}

let modelCatalogCache:
  | { fetchedAt: string; expiresAt: number; models: ModelCatalogEntry[] }
  | null = null;
let themeCatalogCache:
  | { fetchedAt: string; expiresAt: number; enabled: boolean; themes: ThemeCatalogEntry[] }
  | null = null;

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

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeUsage(raw: Record<string, unknown> | undefined): ChatLog["usage"] {
  const promptTokens = num(raw?.prompt_tokens) ?? num(raw?.input_tokens) ?? 0;
  const completionTokens = num(raw?.completion_tokens) ?? num(raw?.output_tokens) ?? 0;
  const details = (raw?.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const cacheReadTokens = num(details.cached_tokens) ?? num(raw?.cache_read_input_tokens);
  const cacheCreationTokens = num(raw?.cache_creation_input_tokens);

  return {
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    ...(cacheCreationTokens ? { cache_creation_input_tokens: cacheCreationTokens } : {}),
    ...(cacheReadTokens ? { cache_read_input_tokens: cacheReadTokens } : {}),
  };
}

function supportsReasoningParams(params: string[] | undefined): boolean {
  if (!params || params.length === 0) return true;
  const set = new Set(params);
  return set.has("reasoning") || set.has("include_reasoning");
}

function extractThinkingDelta(delta: Record<string, unknown> | undefined): string {
  if (!delta) return "";

  if (typeof delta.reasoning === "string") return delta.reasoning;
  if (typeof delta.reasoning_content === "string") return delta.reasoning_content;
  if (typeof delta.thinking === "string") return delta.thinking;

  if (Array.isArray(delta.reasoning_details)) {
    const parts = delta.reasoning_details
      .map((detail) => {
        if (!detail || typeof detail !== "object") return "";
        const d = detail as Record<string, unknown>;
        if (typeof d.text === "string") return d.text;
        if (typeof d.summary === "string") return d.summary;
        if (Array.isArray(d.summary)) {
          return d.summary
            .map((item) => {
              if (!item || typeof item !== "object") return "";
              const s = item as Record<string, unknown>;
              return typeof s.text === "string" ? s.text : "";
            })
            .join("");
        }
        return "";
      })
      .filter(Boolean)
      .join("");
    if (parts) return parts;
  }

  return "";
}

function normalizeSearchTerm(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(\d+)\.0\b/g, "$1")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenizeSearchTerm(value: string): string[] {
  return normalizeSearchTerm(value).split(" ").filter(Boolean);
}

function searchScore(model: ModelCatalogEntry, q: string): number {
  const query = q.trim().toLowerCase();
  const id = model.id.toLowerCase();
  const name = model.name.toLowerCase();
  const description = model.description.toLowerCase();
  const idNorm = normalizeSearchTerm(id);
  const nameNorm = normalizeSearchTerm(name);
  const descNorm = normalizeSearchTerm(description);

  const qNorm = normalizeSearchTerm(query);
  const tokens = tokenizeSearchTerm(query);

  if (!query) return 0;
  if (id === query || name === query) return 100;
  if (qNorm && (idNorm === qNorm || nameNorm === qNorm)) return 95;
  if (id === q || name === q) return 100;
  if (id.startsWith(query) || name.startsWith(query)) return 82;
  if (qNorm && (idNorm.startsWith(qNorm) || nameNorm.startsWith(qNorm))) return 78;
  if (id.includes(query)) return 65;
  if (name.includes(query)) return 58;
  if (description.includes(query)) return 30;

  if (tokens.length > 0) {
    const idHits = tokens.filter((t) => idNorm.includes(t)).length;
    const nameHits = tokens.filter((t) => nameNorm.includes(t)).length;
    const descHits = tokens.filter((t) => descNorm.includes(t)).length;
    if (idHits === tokens.length) return 74 + tokens.length;
    if (nameHits === tokens.length) return 66 + tokens.length;
    if (descHits === tokens.length) return 36 + tokens.length;

    const bestHits = Math.max(idHits, nameHits, descHits);
    if (bestHits > 0) return 12 + bestHits;
  }

  return 0;
}

function filterModels(models: ModelCatalogEntry[], query: string, limit: number): ModelCatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return models.slice(0, limit);

  return models
    .map((model) => ({ model, score: searchScore(model, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id))
    .slice(0, limit)
    .map((x) => x.model);
}

function slugifyThemeName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "theme";
}

function normalizeModelEntries(rawModels: Array<Record<string, unknown>>): ModelCatalogEntry[] {
  return rawModels
    .filter((m) => typeof m.id === "string" && m.id.length > 0)
    .map((m) => ({
      id: m.id as string,
      name: typeof m.name === "string" ? m.name : (m.id as string),
      description: typeof m.description === "string" ? m.description : "",
      context_length: num(m.context_length),
      supported_parameters: Array.isArray(m.supported_parameters)
        ? m.supported_parameters.filter((x): x is string => typeof x === "string")
        : undefined,
      pricing: m.pricing && typeof m.pricing === "object"
        ? {
            prompt: typeof (m.pricing as Record<string, unknown>).prompt === "string"
              ? (m.pricing as Record<string, unknown>).prompt as string
              : undefined,
            completion: typeof (m.pricing as Record<string, unknown>).completion === "string"
              ? (m.pricing as Record<string, unknown>).completion as string
              : undefined,
          }
        : undefined,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function supportsReasoningForModel(modelId: string): boolean {
  const model = modelCatalogCache?.models.find((m) => m.id === modelId);
  if (!model) return true;
  return supportsReasoningParams(model.supported_parameters);
}

async function hydrateModelCacheFromDisk(): Promise<void> {
  const file = Bun.file(MODEL_CACHE_JSON);
  if (!(await file.exists())) return;

  try {
    const data = await file.json() as { fetchedAt?: string; models?: Array<Record<string, unknown>> };
    const fetchedAt = typeof data.fetchedAt === "string" ? data.fetchedAt : new Date(0).toISOString();
    const models = normalizeModelEntries(Array.isArray(data.models) ? data.models : []);
    if (models.length === 0) return;

    const fetchedAtMs = Number.isFinite(Date.parse(fetchedAt)) ? Date.parse(fetchedAt) : 0;
    const ageMs = Math.max(0, Date.now() - fetchedAtMs);

    modelCatalogCache = {
      fetchedAt,
      expiresAt: Date.now() + Math.max(0, MODEL_CACHE_TTL_MS - ageMs),
      models,
    };
  } catch {
    // Ignore malformed on-disk cache.
  }
}

async function fetchOpenRouterModels(forceRefresh = false): Promise<{ fetchedAt: string; models: ModelCatalogEntry[] }> {
  const now = Date.now();
  if (!forceRefresh && modelCatalogCache && modelCatalogCache.expiresAt > now) {
    return { fetchedAt: modelCatalogCache.fetchedAt, models: modelCatalogCache.models };
  }

  const res = await fetch(OPENROUTER_MODELS_URL, {
    headers: {
      Authorization: `Bearer ${openRouterApiKey}`,
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "Local Chat",
    },
  });
  if (!res.ok) {
    if (modelCatalogCache) {
      return { fetchedAt: modelCatalogCache.fetchedAt, models: modelCatalogCache.models };
    }
    throw new Error(`OpenRouter /models failed with ${res.status}`);
  }

  const json = await res.json() as { data?: Array<Record<string, unknown>> };
  const rawModels = Array.isArray(json.data) ? json.data : [];
  const models = normalizeModelEntries(rawModels);

  const fetchedAt = new Date().toISOString();
  modelCatalogCache = {
    fetchedAt,
    expiresAt: now + MODEL_CACHE_TTL_MS,
    models,
  };
  atomicWrite(MODEL_CACHE_JSON, JSON.stringify({ fetchedAt, models }, null, 2)).catch(console.error);

  return { fetchedAt, models };
}

async function fetchObsidianThemes(forceRefresh = false): Promise<{ fetchedAt: string; enabled: boolean; themes: ThemeCatalogEntry[] }> {
  const now = Date.now();
  if (!forceRefresh && themeCatalogCache && themeCatalogCache.expiresAt > now) {
    return {
      fetchedAt: themeCatalogCache.fetchedAt,
      enabled: themeCatalogCache.enabled,
      themes: themeCatalogCache.themes,
    };
  }

  let dirs: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    dirs = await readdir(OBSIDIAN_THEMES_DIR, {
      withFileTypes: true,
      encoding: "utf8",
    });
  } catch {
    const fetchedAt = new Date().toISOString();
    themeCatalogCache = {
      fetchedAt,
      expiresAt: now + THEME_CACHE_TTL_MS,
      enabled: false,
      themes: [],
    };
    return { fetchedAt, enabled: false, themes: [] };
  }

  const usedIds = new Set<string>();
  const themes: ThemeCatalogEntry[] = [];

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const cssPath = `${OBSIDIAN_THEMES_DIR}/${dir.name}/theme.css`;
    if (!(await Bun.file(cssPath).exists())) continue;

    const baseId = slugifyThemeName(dir.name);
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix++;
    }
    usedIds.add(id);

    themes.push({
      id,
      name: dir.name,
      cssPath,
    });
  }

  themes.sort((a, b) => a.name.localeCompare(b.name));

  const fetchedAt = new Date().toISOString();
  themeCatalogCache = {
    fetchedAt,
    expiresAt: now + THEME_CACHE_TTL_MS,
    enabled: true,
    themes,
  };
  return { fetchedAt, enabled: true, themes };
}

async function resolveRequestedModelId(requestedModel: string): Promise<string> {
  const requested = requestedModel.trim();
  if (!requested) return requestedModel;

  // If caller already passed a canonical model id, trust it.
  if (requested.includes("/")) return requested;

  try {
    const { models } = await fetchOpenRouterModels(false);
    if (models.length === 0) return requested;

    const exactName = models.find((m) => m.name.toLowerCase() === requested.toLowerCase());
    if (exactName) return exactName.id;

    const candidates = filterModels(models, requested, 3);
    if (candidates.length === 0) return requested;

    const best = candidates[0];
    const score = searchScore(best, requested);
    // Conservative threshold to avoid accidental remaps.
    if (score >= 66) return best.id;
  } catch {
    // If catalog lookup fails, let upstream validate raw model id.
  }

  return requested;
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

  if (typeof b.model !== "string" || b.model.trim().length === 0) {
    return { ok: false, error: "model is required" };
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
      model: b.model.trim(),
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

  const { model: requestedModel, system, messages, session_id, thinking } = v.data;
  const model = await resolveRequestedModelId(requestedModel);
  const logId = crypto.randomUUID();
  const t0 = performance.now();
  let ttft: number | null = null;
  let ttfThinking: number | null = null;
  let fullResponse = "";
  let fullThinking = "";
  let upstreamUsage: Record<string, unknown> | undefined;

  const openRouterMessages: Array<Record<string, unknown>> = [];
  if (system) {
    openRouterMessages.push({
      role: "system",
      content: [
        {
          type: "text",
          text: system,
          cache_control: { type: "ephemeral", ttl: PROMPT_CACHE_TTL },
        },
      ],
    });
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    openRouterMessages.push({
      role: msg.role,
      content: [
        {
          type: "text",
          text: msg.content,
          ...(i === messages.length - 2 && {
            cache_control: { type: "ephemeral", ttl: PROMPT_CACHE_TTL },
          }),
        },
      ],
    });
  }

  const requestBody: Record<string, unknown> = {
    model,
    messages: openRouterMessages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: thinking?.enabled ? 32000 : 8192,
    user: session_id,
  };
  if (thinking?.enabled && supportsReasoningForModel(model)) {
    requestBody.reasoning = { effort: "high" };
  }

  let upstream: Response;
  try {
    upstream = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: openRouterHeaders(),
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Failed to connect to OpenRouter";
    return errorResponse(msg, 502);
  }

  if (!upstream.ok) {
    const details = await upstream.text();
    const trimmed = details.trim().slice(0, 600);
    return errorResponse(
      trimmed
        ? `OpenRouter request failed (${upstream.status}): ${trimmed}`
        : `OpenRouter request failed (${upstream.status})`,
      upstream.status >= 500 ? 502 : upstream.status,
    );
  }
  if (!upstream.body) {
    return errorResponse("OpenRouter response did not include a stream", 502);
  }

  const encoder = new TextEncoder();
  const sse = (obj: Record<string, unknown>) =>
    encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);

  const readable = new ReadableStream({
    async start(controller) {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");

            const payload = rawEvent
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");

            if (!payload || payload === "[DONE]") continue;

            let chunk: Record<string, unknown>;
            try {
              chunk = JSON.parse(payload) as Record<string, unknown>;
            } catch {
              continue;
            }

            if (chunk.usage && typeof chunk.usage === "object") {
              upstreamUsage = chunk.usage as Record<string, unknown>;
            }

            const errorObj = chunk.error;
            if (errorObj && typeof errorObj === "object") {
              const msg = (errorObj as Record<string, unknown>).message;
              throw new Error(typeof msg === "string" ? msg : "OpenRouter stream error");
            }

            const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
            const first = choices[0];
            if (!first || typeof first !== "object") continue;
            const delta = (first as Record<string, unknown>).delta;
            if (!delta || typeof delta !== "object") continue;

            const text = typeof (delta as Record<string, unknown>).content === "string"
              ? (delta as Record<string, unknown>).content as string
              : "";
            if (text) {
              ttft ??= performance.now() - t0;
              fullResponse += text;
              controller.enqueue(sse({ type: "delta", text }));
            }

            const thinkingDelta = extractThinkingDelta(delta as Record<string, unknown>);
            if (thinkingDelta) {
              ttfThinking ??= performance.now() - t0;
              fullThinking += thinkingDelta;
              controller.enqueue(sse({ type: "thinking_delta", thinking: thinkingDelta }));
            }
          }
        }

        if (buffer.startsWith("data:")) {
          try {
            const chunk = JSON.parse(buffer.slice(5).trim()) as Record<string, unknown>;
            if (chunk.usage && typeof chunk.usage === "object") {
              upstreamUsage = chunk.usage as Record<string, unknown>;
            }
          } catch {
            // Ignore trailing partial JSON.
          }
        }

        const elapsed = performance.now() - t0;
        const usage = normalizeUsage(upstreamUsage);

        appendLog({
          id: logId,
          session_id,
          timestamp: new Date().toISOString(),
          model,
          system_prompt: system,
          messages,
          response: fullResponse,
          thinking_content: fullThinking || undefined,
          usage,
          latency: {
            time_to_first_token_ms: Math.round(ttft ?? elapsed),
            total_time_ms: Math.round(elapsed),
            time_to_first_thinking_ms: ttfThinking ? Math.round(ttfThinking) : undefined,
          },
          thinking_enabled: thinking?.enabled,
          thinking_budget: thinking?.budget_tokens,
        }).catch(console.error);

        controller.enqueue(sse({ type: "done", usage }));
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
        reader.releaseLock();
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

async function handleModels(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const refresh = url.searchParams.get("refresh") === "1";
  const requestedLimit = Number.parseInt(url.searchParams.get("limit") || "", 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(500, requestedLimit))
    : 200;

  try {
    const catalog = await fetchOpenRouterModels(refresh);
    const models = filterModels(catalog.models, q, limit);
    return jsonResponse({
      provider: OPENROUTER_PROVIDER,
      query: q,
      total: catalog.models.length,
      fetchedAt: catalog.fetchedAt,
      models,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Failed to fetch models";
    return errorResponse(msg, 502);
  }
}

async function handleThemes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const refresh = url.searchParams.get("refresh") === "1";
  const requestedLimit = Number.parseInt(url.searchParams.get("limit") || "", 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(100, requestedLimit))
    : 100;

  const catalog = await fetchObsidianThemes(refresh);

  const themes = catalog.themes
    .filter((theme) => !q || theme.id.includes(q) || theme.name.toLowerCase().includes(q))
    .slice(0, limit)
    .map((theme) => ({ id: theme.id, name: theme.name }));

  return jsonResponse({
    provider: OPENROUTER_PROVIDER,
    source: "obsidian",
    enabled: catalog.enabled,
    fetchedAt: catalog.fetchedAt,
    total: catalog.themes.length,
    themes,
  });
}

async function handleThemeCss(id: string): Promise<Response> {
  if (!THEME_ID_RE.test(id)) {
    return errorResponse("Invalid theme id");
  }

  const catalog = await fetchObsidianThemes(false);
  const theme = catalog.themes.find((entry) => entry.id === id);
  if (!theme) return notFound("Theme not found");

  const file = Bun.file(theme.cssPath);
  if (!(await file.exists())) return notFound("Theme file missing");

  return new Response(file, {
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": STATIC_CACHE,
      "X-Theme-Name": theme.name,
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
          provider: str(b.provider) || existing.provider || OPENROUTER_PROVIDER,
          model: str(b.model) || existing.model || DEFAULT_MODEL,
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
          provider: str(b.provider) || OPENROUTER_PROVIDER,
          model: str(b.model) || DEFAULT_MODEL,
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
  route("GET",  "/api/models",     (req) => handleModels(req)),
  route("GET",  "/api/themes",     (req) => handleThemes(req)),
  route("GET",  "/api/themes/:id.css", (_req, p) => handleThemeCss(p.id)),
  route("GET",  "/api/chats",      ()    => handleListChats()),
  route("POST", "/api/chats",      (req) => handleSaveChat(req)),
  route("GET",  "/api/chats/:id",  (_req, p) => handleGetChat(p.id)),
  route("PATCH","/api/chats/:id",  (req, p) => handleRenameChat(p.id, req)),
  route("DELETE","/api/chats/:id", (_req, p) => handleDeleteChat(p.id)),
];

// ── Server ──────────────────────────────────────────────────────────────────

await mkdir(LOGS_DIR, { recursive: true });
await mkdir(CHATS_DIR, { recursive: true });
await hydrateModelCacheFromDisk();

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
