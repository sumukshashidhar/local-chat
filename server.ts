import { appendFile, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { LangfuseTracing } from "./langfuse";
import type { ChatInteractionContext, ModelPricing } from "./langfuse";
import type { LogContext, LogLevel } from "./logger";
import { logger, shouldLog } from "./logger";
import { loadDotEnv } from "./env";
import { buildOpenRouterMessages, PROMPT_CACHE_TTL } from "./openrouter-messages";
import type { Message } from "./types";

// ── Config ──────────────────────────────────────────────────────────────────

loadDotEnv();

function parsePort(raw: string | undefined): number {
  const parsed = Number.parseInt(raw || "9999", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 9999;
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const PORT = parsePort(process.env.PORT);
const LOGS_DIR = process.env.LOGS_DIR || "./logs";
const CHATS_DIR = `${LOGS_DIR}/chats`;
const CHAT_LOGS_JSONL = `${LOGS_DIR}/chat_logs.jsonl`;
const MODEL_CACHE_JSON = `${LOGS_DIR}/openrouter_models_cache.json`;
/** Preferred reasoning effort. Mapped down per-model when unsupported (e.g. Kimi K3 only allows "max"). */
const REASONING_EFFORT = "xhigh" as const;
const REASONING_EFFORT_RANK = [
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
] as const;
type ReasoningEffort = (typeof REASONING_EFFORT_RANK)[number];
const DEFAULT_MAX_TOKENS = 8192;
const REASONING_MAX_TOKENS = 32_000;
/** Always-on reasoners (Kimi K3, etc.) need more room so thinking does not exhaust max_tokens. */
const MANDATORY_REASONING_MAX_TOKENS = 65_536;
const DEFAULT_MODEL = process.env.OPENROUTER_DEFAULT_MODEL || "google/gemini-2.0-flash-001";
const OPENROUTER_PROVIDER = "openrouter" as const;
const OPENROUTER_API_BASE = (process.env.OPENROUTER_API_BASE || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const OPENROUTER_CHAT_URL = `${OPENROUTER_API_BASE}/chat/completions`;
const OPENROUTER_MODELS_URL = `${OPENROUTER_API_BASE}/models`;
const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY || "";
const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY || "";
const LANGFUSE_BASE_URL = (process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com").replace(/\/+$/, "");
/** Export attempts against slow/self-hosted instances need headroom; failures drop buffered spans. */
const LANGFUSE_REQUEST_TIMEOUT_MS = parsePositiveInteger(process.env.LANGFUSE_REQUEST_TIMEOUT_MS, 15_000);
const LANGFUSE_ENVIRONMENT = process.env.LANGFUSE_TRACING_ENVIRONMENT || "development";
const OPENROUTER_CONNECT_TIMEOUT_MS = parsePositiveInteger(process.env.OPENROUTER_CONNECT_TIMEOUT_MS, 60_000);
const OPENROUTER_STREAM_IDLE_TIMEOUT_MS = parsePositiveInteger(process.env.OPENROUTER_STREAM_IDLE_TIMEOUT_MS, 60_000);
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const THEME_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_OBSIDIAN_THEMES_DIR = "/Users/sumukshashidhar/Documents/root/resources/vault/dinnerparty/.obsidian/themes";
const OBSIDIAN_THEMES_DIR = process.env.OBSIDIAN_THEMES_DIR || DEFAULT_OBSIDIAN_THEMES_DIR;
const CHAT_ID_RE = /^[a-zA-Z0-9-]+$/;
const THEME_ID_RE = /^[a-z0-9-]+$/;
const PUBLIC_DIR = resolve("./public");

function errorDetails(error: unknown): LogContext {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(shouldLog("debug") && error.stack ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
}

export function parseEnabled(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  return defaultValue;
}

const LANGFUSE_ENABLED = parseEnabled(process.env.LANGFUSE_ENABLED, true);

const langfuse = new LangfuseTracing({
  enabled: LANGFUSE_ENABLED,
  publicKey: LANGFUSE_PUBLIC_KEY,
  secretKey: LANGFUSE_SECRET_KEY,
  baseUrl: LANGFUSE_BASE_URL,
  requestTimeoutMs: LANGFUSE_REQUEST_TIMEOUT_MS,
  environment: LANGFUSE_ENVIRONMENT,
  logger,
});

const openRouterApiKey = process.env.OPENROUTER_API_KEY;
if (!openRouterApiKey) {
  logger.error("startup.missing_openrouter_api_key", {
    message: "Set OPENROUTER_API_KEY before starting the server.",
  });
  process.exit(1);
}

function openRouterHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${openRouterApiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": `http://localhost:${PORT}`,
    "X-Title": "Local Chat",
  };
}

// ── Types ───────────────────────────────────────────────────────────────────

interface ChatRequest {
  model: string;
  system: string;
  messages: Message[];
  session_id: string;
  thinking?: { enabled: boolean; budget_tokens?: number };
  /**
   * How this turn was produced. The client branch tree forks on retry or
   * edited re-send; passing the fork point lets traces express that lineage.
   */
  interaction?: ChatInteractionContext;
}

const INTERACTION_KINDS = ["send", "continue", "retry", "edit_resend"] as const;

function parseInteraction(value: unknown):
  | { ok: true; interaction: ChatInteractionContext | undefined }
  | { ok: false, error: string } {
  if (value === undefined) return { ok: true, interaction: undefined };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "interaction must be an object" };
  }

  const raw = value as Record<string, unknown>;
  if (!INTERACTION_KINDS.includes(raw.kind as never)) {
    return {
      ok: false,
      error: `interaction.kind must be one of: ${INTERACTION_KINDS.join(", ")}`,
    };
  }

  const optionalId = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 && v.length <= 200 ? v : undefined;

  const positiveInt = (v: unknown): number | undefined => {
    const parsed = typeof v === "number" ? v : Number.parseInt(v as string, 10);
    return Number.isFinite(parsed) && parsed > 0 && Number.isInteger(parsed) && parsed < 1_000_000
      ? parsed
      : undefined;
  };

  const chatId = optionalId(raw.chat_id);
  if (chatId !== undefined && !CHAT_ID_RE.test(chatId)) {
    return { ok: false, error: "interaction.chat_id is invalid" };
  }

  const assistantNodeId = optionalId(raw.assistant_node_id);
  const branchedFromNodeId = optionalId(raw.branched_from_node_id);
  const siblingIndex = positiveInt(raw.sibling_index);
  const siblingCount = positiveInt(raw.sibling_count);
  const pathLength = positiveInt(raw.path_length);

  return {
    ok: true,
    interaction: {
      kind: raw.kind as ChatInteractionContext["kind"],
      ...(chatId ? { chatId } : {}),
      ...(assistantNodeId ? { assistantNodeId } : {}),
      ...(branchedFromNodeId ? { branchedFromNodeId } : {}),
      ...(siblingIndex ? { siblingIndex } : {}),
      ...(siblingCount ? { siblingCount } : {}),
      ...(pathLength ? { pathLength } : {}),
    },
  };
}

// A branch tree of messages. The client owns its semantics (active path,
// sibling ordering); the server persists it and hands it back verbatim.
// `messages` on SavedChat mirrors the tree's active path for previews and any
// reader that predates branching.
interface ChatTreeNode {
  id: string;
  role: "user" | "assistant";
  content: string;
  parentId: string | null;
  children: string[];
  activeChildId: string | null;
  thinking?: string;
  meta?: Record<string, unknown>;
}

interface ChatTree {
  version: number;
  rootChildren: string[];
  activeRootId: string | null;
  nodes: Record<string, ChatTreeNode>;
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
  tree?: ChatTree;
}

interface ChatLog {
  id: string;
  request_id: string;
  status: "completed" | "failed" | "cancelled";
  session_id: string;
  timestamp: string;
  provider: string;
  model: string;
  requested_model?: string;
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
  /** How this turn was produced (fork lineage for retries / edited re-sends). */
  interaction?: ChatInteractionContext;
  error?: string;
}

interface ModelReasoningInfo {
  /** Effort values this model accepts, highest first when provided by OpenRouter. */
  supported_efforts?: string[];
  default_effort?: string;
  default_enabled?: boolean;
  mandatory?: boolean;
}

interface ModelCatalogEntry {
  id: string;
  name: string;
  description: string;
  context_length?: number;
  supported_parameters?: string[];
  reasoning?: ModelReasoningInfo;
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
    cache_read?: string;
    cache_write?: string;
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

function dateFromPerfDelta(start: Date, deltaMs: number | null): Date | undefined {
  return deltaMs === null ? undefined : new Date(start.getTime() + Math.max(0, deltaMs));
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

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeUsage(raw: Record<string, unknown> | undefined): ChatLog["usage"] {
  const promptTokens = num(raw?.prompt_tokens) ?? num(raw?.input_tokens) ?? 0;
  const completionTokens = num(raw?.completion_tokens) ?? num(raw?.output_tokens) ?? 0;
  const details = (raw?.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const cacheReadTokens = num(details.cached_tokens) ?? num(raw?.cache_read_input_tokens);
  const cacheCreationTokens =
    num(details.cache_write_tokens) ??
    num(raw?.cache_creation_input_tokens) ??
    num(raw?.cache_write_input_tokens);

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

function priceString(pricing: Record<string, unknown>, key: string): string | undefined {
  const value = pricing[key];
  return typeof value === "string" ? value : undefined;
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

function normalizeReasoningInfo(raw: unknown): ModelReasoningInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const supported_efforts = Array.isArray(r.supported_efforts)
    ? r.supported_efforts.filter((x): x is string => typeof x === "string" && x.length > 0)
    : undefined;
  const info: ModelReasoningInfo = {};
  if (supported_efforts && supported_efforts.length > 0) info.supported_efforts = supported_efforts;
  if (typeof r.default_effort === "string" && r.default_effort.length > 0) {
    info.default_effort = r.default_effort;
  }
  if (typeof r.default_enabled === "boolean") info.default_enabled = r.default_enabled;
  if (typeof r.mandatory === "boolean") info.mandatory = r.mandatory;
  return Object.keys(info).length > 0 ? info : undefined;
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
      reasoning: normalizeReasoningInfo(m.reasoning),
      pricing: m.pricing && typeof m.pricing === "object"
        ? {
            prompt: priceString(m.pricing as Record<string, unknown>, "prompt"),
            completion: priceString(m.pricing as Record<string, unknown>, "completion"),
            input_cache_read: priceString(m.pricing as Record<string, unknown>, "input_cache_read"),
            input_cache_write: priceString(m.pricing as Record<string, unknown>, "input_cache_write"),
            cache_read: priceString(m.pricing as Record<string, unknown>, "cache_read"),
            cache_write: priceString(m.pricing as Record<string, unknown>, "cache_write"),
          }
        : undefined,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function getModelCatalogEntry(modelId: string): ModelCatalogEntry | undefined {
  return modelCatalogCache?.models.find((m) => m.id === modelId);
}

/** Per-token USD rates from the OpenRouter catalog, for Langfuse cost tracking. */
function pricingForModel(modelId: string): ModelPricing | undefined {
  const pricing = getModelCatalogEntry(modelId)?.pricing;
  if (!pricing) return undefined;

  const num = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const entry: ModelPricing = {
    ...(num(pricing.prompt) !== undefined ? { prompt: num(pricing.prompt) } : {}),
    ...(num(pricing.completion) !== undefined ? { completion: num(pricing.completion) } : {}),
    ...(num(pricing.input_cache_read) !== undefined ? { input_cache_read: num(pricing.input_cache_read) } : {}),
    ...(num(pricing.input_cache_write) !== undefined ? { input_cache_write: num(pricing.input_cache_write) } : {}),
    ...(num(pricing.cache_read) !== undefined ? { cache_read: num(pricing.cache_read) } : {}),
    ...(num(pricing.cache_write) !== undefined ? { cache_write: num(pricing.cache_write) } : {}),
  };
  return Object.keys(entry).length > 0 ? entry : undefined;
}

function supportsReasoningForModel(modelId: string): boolean {
  const info = reasoningInfoForModel(modelId);
  if (info?.mandatory || info?.default_enabled) return true;
  const model = getModelCatalogEntry(modelId);
  if (!model) return true;
  return supportsReasoningParams(model.supported_parameters);
}

function isReasoningMandatoryForModel(modelId: string): boolean {
  return reasoningInfoForModel(modelId)?.mandatory === true;
}

function effortRank(effort: string): number {
  const idx = REASONING_EFFORT_RANK.indexOf(effort as ReasoningEffort);
  return idx >= 0 ? idx : REASONING_EFFORT_RANK.length;
}

/**
 * Catalog may lag (disk cache without OpenRouter's newer `reasoning` block).
 * Known model-family constraints fill the gap.
 */
function heuristicReasoningInfo(modelId: string): ModelReasoningInfo | undefined {
  const id = modelId.toLowerCase();
  // Moonshot Kimi K3 always reasons; only effort "max" is supported today.
  if (/(^|\/)kimi-k3(?:[:/]|$)/.test(id) || id.includes("kimi-k3")) {
    return {
      mandatory: true,
      default_enabled: true,
      supported_efforts: ["max"],
    };
  }
  return undefined;
}

function reasoningInfoForModel(modelId: string): ModelReasoningInfo | undefined {
  return getModelCatalogEntry(modelId)?.reasoning ?? heuristicReasoningInfo(modelId);
}

/**
 * Pick a reasoning.effort value this model accepts.
 * OpenRouter/Moonshot models like kimi-k3 only support "max"; sending "xhigh"
 * with require_parameters can fail or be rejected upstream.
 */
function reasoningEffortForModel(modelId: string, preferred: string = REASONING_EFFORT): string {
  const supported = reasoningInfoForModel(modelId)?.supported_efforts;
  if (!supported || supported.length === 0) return preferred;

  const normalizedPreferred = preferred.toLowerCase();
  if (supported.some((e) => e.toLowerCase() === normalizedPreferred)) {
    return supported.find((e) => e.toLowerCase() === normalizedPreferred) || preferred;
  }

  // Prefer the strongest effort the model actually lists.
  const ranked = [...supported].sort((a, b) => effortRank(a.toLowerCase()) - effortRank(b.toLowerCase()));
  return ranked[0] || preferred;
}

function maxTokensForReasoning(modelId: string, reasoningEnabled: boolean): number {
  if (!reasoningEnabled) return DEFAULT_MAX_TOKENS;
  if (isReasoningMandatoryForModel(modelId)) return MANDATORY_REASONING_MAX_TOKENS;
  return REASONING_MAX_TOKENS;
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
    logger.info("models.cache.hydrated", {
      path: MODEL_CACHE_JSON,
      models: models.length,
      fetched_at: fetchedAt,
    });
  } catch (error) {
    logger.warn("models.cache.hydrate_failed", {
      path: MODEL_CACHE_JSON,
      error: errorDetails(error),
    });
  }
}

async function fetchOpenRouterModels(forceRefresh = false): Promise<{ fetchedAt: string; models: ModelCatalogEntry[] }> {
  const now = Date.now();
  if (!forceRefresh && modelCatalogCache && modelCatalogCache.expiresAt > now) {
    logger.debug("models.cache.hit", {
      models: modelCatalogCache.models.length,
      fetched_at: modelCatalogCache.fetchedAt,
    });
    return { fetchedAt: modelCatalogCache.fetchedAt, models: modelCatalogCache.models };
  }

  logger.info("models.fetch.start", { force_refresh: forceRefresh });
  const res = await fetch(OPENROUTER_MODELS_URL, {
    headers: {
      Authorization: `Bearer ${openRouterApiKey}`,
      "HTTP-Referer": `http://localhost:${PORT}`,
      "X-Title": "Local Chat",
    },
  });
  if (!res.ok) {
    if (modelCatalogCache) {
      logger.warn("models.fetch.failed_using_cache", {
        status: res.status,
        fetched_at: modelCatalogCache.fetchedAt,
      });
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
  atomicWrite(MODEL_CACHE_JSON, JSON.stringify({ fetchedAt, models }, null, 2)).catch((error) => {
    logger.warn("models.cache.write_failed", {
      path: MODEL_CACHE_JSON,
      error: errorDetails(error),
    });
  });

  logger.info("models.fetch.complete", {
    models: models.length,
    fetched_at: fetchedAt,
  });

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
  } catch (error) {
    const fetchedAt = new Date().toISOString();
    themeCatalogCache = {
      fetchedAt,
      expiresAt: now + THEME_CACHE_TTL_MS,
      enabled: false,
      themes: [],
    };
    logger.warn("themes.scan_unavailable", {
      path: OBSIDIAN_THEMES_DIR,
      error: errorDetails(error),
    });
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
  logger.info("themes.scan.complete", {
    path: OBSIDIAN_THEMES_DIR,
    themes: themes.length,
  });
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

async function writeChatLog(log: ChatLog): Promise<void> {
  try {
    await appendLog(log);
    logger.info("chat.log.written", {
      request_id: log.request_id,
      log_id: log.id,
      status: log.status,
      path: CHAT_LOGS_JSONL,
    });
  } catch (error) {
    logger.error("chat.log.write_failed", {
      request_id: log.request_id,
      log_id: log.id,
      status: log.status,
      path: CHAT_LOGS_JSONL,
      error: errorDetails(error),
    });
  }
}

function chatPath(id: string): string {
  return `${CHATS_DIR}/${id}.json`;
}

async function readChat(id: string): Promise<SavedChat | null> {
  const file = Bun.file(chatPath(id));
  if (!(await file.exists())) return null;
  try {
    return await file.json();
  } catch (error) {
    logger.warn("chat.read_failed", {
      chat_id: id,
      path: chatPath(id),
      error: errorDetails(error),
    });
    return null;
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

function validateChatId(id: string): string | null {
  return CHAT_ID_RE.test(id) ? null : "Invalid chat ID";
}

function validateMessages(value: unknown):
  | { ok: true; messages: Message[] }
  | { ok: false; error: string } {

  if (!Array.isArray(value)) {
    return { ok: false, error: "Messages must be an array" };
  }

  const messages: Message[] = [];
  for (const msg of value) {
    if (!msg || typeof msg !== "object") {
      return { ok: false, error: "Each message must be an object" };
    }

    const role = (msg as Record<string, unknown>).role;
    const content = (msg as Record<string, unknown>).content;

    if (role !== "user" && role !== "assistant") {
      return { ok: false, error: "Message role must be 'user' or 'assistant'" };
    }
    if (typeof content !== "string") {
      return { ok: false, error: "Message content must be a string" };
    }

    const thinkingRaw = (msg as Record<string, unknown>).thinking
      ?? (msg as Record<string, unknown>).reasoning
      ?? (msg as Record<string, unknown>).reasoning_content;
    const thinking =
      typeof thinkingRaw === "string" && thinkingRaw.length > 0 ? thinkingRaw : undefined;

    messages.push({
      role,
      content,
      ...(thinking ? { thinking } : {}),
    });
  }

  return { ok: true, messages };
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

  const parsedMessages = validateMessages(b.messages);
  if (!parsedMessages.ok) return parsedMessages;

  let thinking: ChatRequest["thinking"];
  if (b.thinking !== undefined) {
    if (typeof b.thinking !== "object" || b.thinking === null) {
      return { ok: false, error: "thinking must be an object" };
    }
    const t = b.thinking as Record<string, unknown>;
    if (typeof t.enabled !== "boolean") {
      return { ok: false, error: "thinking.enabled must be a boolean" };
    }
    if (
      t.budget_tokens !== undefined &&
      (
        typeof t.budget_tokens !== "number" ||
        !Number.isFinite(t.budget_tokens) ||
        t.budget_tokens < 1024
      )
    ) {
      return { ok: false, error: "thinking.budget_tokens must be a number >= 1024" };
    }
    thinking = { enabled: t.enabled, budget_tokens: t.budget_tokens as number | undefined };
  }

  const parsedInteraction = parseInteraction(b.interaction);
  if (!parsedInteraction.ok) return parsedInteraction;

  return {
    ok: true,
    data: {
      model: b.model.trim(),
      system: (b.system as string) || "",
      messages: parsedMessages.messages,
      session_id: b.session_id as string,
      thinking,
      interaction: parsedInteraction.interaction,
    },
  };
}

// ── Handlers: Chat Streaming ────────────────────────────────────────────────

interface RequestContext {
  requestId: string;
  method: string;
  pathname: string;
  startedAt: number;
}

class StreamCancelledError extends Error {
  constructor() {
    super("Stream cancelled");
    this.name = "StreamCancelledError";
  }
}

class UpstreamTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamTimeoutError";
  }
}

function formatTimeoutMs(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof StreamCancelledError) return true;
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.message.toLowerCase().includes("abort");
}

function isUpstreamTimeoutError(error: unknown): boolean {
  return error instanceof UpstreamTimeoutError;
}

async function handleStream(req: Request, ctx: RequestContext): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch {
    return errorResponse("Invalid JSON");
  }

  const v = validateChatRequest(body);
  if (!v.ok) return errorResponse(v.error);

  const { model: requestedModel, system, messages, session_id, thinking, interaction } = v.data;
  const model = await resolveRequestedModelId(requestedModel);
  const logId = crypto.randomUUID();
  const streamStartTime = new Date();
  const t0 = performance.now();
  let ttft: number | null = null;
  let ttfThinking: number | null = null;
  let fullResponse = "";
  let fullThinking = "";
  let upstreamUsage: Record<string, unknown> | undefined;
  const thinkingRequested = thinking?.enabled === true;
  const thinkingSupported = supportsReasoningForModel(model);
  const reasoningMandatory = isReasoningMandatoryForModel(model);
  // Kimi K3 (and similar) always reason; still send a valid effort + higher max_tokens
  // even when the UI Think toggle is off so output is not truncated mid-thinking.
  const reasoningEnabled =
    reasoningMandatory || (thinkingRequested && thinkingSupported);
  const reasoningEffort = reasoningEnabled ? reasoningEffortForModel(model) : undefined;

  logger.info("chat.stream.start", {
    request_id: ctx.requestId,
    log_id: logId,
    session_id,
    requested_model: requestedModel !== model ? requestedModel : undefined,
    model,
    messages: messages.length,
    system_prompt_chars: system.length,
    thinking_requested: thinkingRequested,
    thinking_sent: reasoningEnabled,
    reasoning_mandatory: reasoningMandatory || undefined,
    reasoning_effort: reasoningEffort,
    interaction: interaction?.kind || "new",
  });

  if (thinkingRequested && !thinkingSupported && !reasoningMandatory) {
    logger.info("chat.thinking.skipped_unsupported_model", {
      request_id: ctx.requestId,
      model,
    });
  }

  const openRouterMessages = buildOpenRouterMessages(system, messages);

  const maxTokens = maxTokensForReasoning(model, reasoningEnabled);
  const modelParameters: Record<string, unknown> = {
    stream: true,
    max_tokens: maxTokens,
    thinking_enabled: reasoningEnabled,
    thinking_budget: thinking?.budget_tokens,
  };

  const requestBody: Record<string, unknown> = {
    model,
    messages: openRouterMessages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens,
    user: session_id,
  };
  if (reasoningEnabled && reasoningEffort) {
    requestBody.reasoning = { effort: reasoningEffort };
    requestBody.provider = { require_parameters: true };
    modelParameters.reasoning_effort = reasoningEffort;
    modelParameters.require_parameters = true;
  }

  const langfuseTrace = await langfuse.startChatTrace({
    logId,
    requestId: ctx.requestId,
    sessionId: session_id,
    provider: OPENROUTER_PROVIDER,
    requestedModel,
    model,
    systemPrompt: system,
    messages,
    upstreamMessages: openRouterMessages,
    modelParameters,
    thinkingRequested,
    thinkingEnabled: reasoningEnabled,
    interaction,
    pricing: pricingForModel(model),
    startTime: streamStartTime,
  });

  function captureStreamOutcome(status: ChatLog["status"], error?: string) {
    const endTime = new Date();
    const elapsed = performance.now() - t0;
    const usage = normalizeUsage(upstreamUsage);
    const latency = {
      time_to_first_token_ms: Math.round(ttft ?? elapsed),
      total_time_ms: Math.round(elapsed),
      time_to_first_thinking_ms: ttfThinking !== null ? Math.round(ttfThinking) : undefined,
    };

    langfuseTrace?.finish(
      {
        status,
        response: fullResponse,
        thinking: fullThinking || undefined,
        usage,
        latency,
        completionStartTime: dateFromPerfDelta(streamStartTime, ttft),
        endTime,
        error,
      },
      pricingForModel(model),
    );

    return { usage, latency, endTime };
  }

  const upstreamAbortController = new AbortController();
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let clientCancelled = req.signal.aborted;
  let upstreamTimedOut = false;
  let upstreamTimeoutMessage = "";
  const cancelUpstream = (reason: unknown = "client_cancelled") => {
    clientCancelled = true;
    if (!upstreamAbortController.signal.aborted) {
      upstreamAbortController.abort(reason);
    }
    if (upstreamReader) {
      upstreamReader.cancel(reason).catch(() => undefined);
    }
  };
  const timeoutUpstream = (message: string) => {
    upstreamTimedOut = true;
    upstreamTimeoutMessage = message;
    const error = new UpstreamTimeoutError(message);
    if (!upstreamAbortController.signal.aborted) {
      upstreamAbortController.abort(error);
    }
    if (upstreamReader) {
      upstreamReader.cancel(error).catch(() => undefined);
    }
  };
  const abortUpstream = () => cancelUpstream("client_cancelled");
  if (req.signal.aborted) {
    abortUpstream();
  } else {
    req.signal.addEventListener("abort", abortUpstream, { once: true });
  }

  let upstream: Response;
  let connectTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timeoutUpstream(
      `OpenRouter request timed out after ${formatTimeoutMs(OPENROUTER_CONNECT_TIMEOUT_MS)} before the stream started`,
    );
  }, OPENROUTER_CONNECT_TIMEOUT_MS);
  const clearConnectTimeout = () => {
    if (connectTimeout) {
      clearTimeout(connectTimeout);
      connectTimeout = null;
    }
  };

  try {
    upstream = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: openRouterHeaders(),
      body: JSON.stringify(requestBody),
      signal: upstreamAbortController.signal,
    });
  } catch (error) {
    clearConnectTimeout();
    req.signal.removeEventListener("abort", abortUpstream);
    if (upstreamTimedOut) {
      captureStreamOutcome("failed", upstreamTimeoutMessage);
      logger.warn("chat.upstream.timeout_before_stream", {
        request_id: ctx.requestId,
        log_id: logId,
        model,
        timeout_ms: OPENROUTER_CONNECT_TIMEOUT_MS,
      });
      return errorResponse(upstreamTimeoutMessage, 504);
    }
    if (clientCancelled || isAbortLikeError(error)) {
      captureStreamOutcome("cancelled", "cancelled by client");
      logger.info("chat.upstream.cancelled_before_stream", {
        request_id: ctx.requestId,
        log_id: logId,
        model,
      });
      return new Response(null, { status: 499 });
    }
    const msg = error instanceof Error ? error.message : "Failed to connect to OpenRouter";
    captureStreamOutcome("failed", msg);
    logger.error("chat.upstream.connection_failed", {
      request_id: ctx.requestId,
      log_id: logId,
      model,
      error: errorDetails(error),
    });
    return errorResponse(msg, 502);
  }
  clearConnectTimeout();

  if (!upstream.ok) {
    req.signal.removeEventListener("abort", abortUpstream);
    const details = await upstream.text();
    const trimmed = details.trim().slice(0, 600);
    captureStreamOutcome(
      "failed",
      trimmed
        ? `OpenRouter request failed (${upstream.status}): ${trimmed}`
        : `OpenRouter request failed (${upstream.status})`,
    );
    logger.warn("chat.upstream.rejected", {
      request_id: ctx.requestId,
      log_id: logId,
      model,
      status: upstream.status,
      details: trimmed || undefined,
    });
    return errorResponse(
      trimmed
        ? `OpenRouter request failed (${upstream.status}): ${trimmed}`
        : `OpenRouter request failed (${upstream.status})`,
      upstream.status >= 500 ? 502 : upstream.status,
    );
  }
  if (!upstream.body) {
    req.signal.removeEventListener("abort", abortUpstream);
    captureStreamOutcome("failed", "OpenRouter response did not include a stream");
    logger.error("chat.upstream.empty_stream", {
      request_id: ctx.requestId,
      log_id: logId,
      model,
    });
    return errorResponse("OpenRouter response did not include a stream", 502);
  }

  const encoder = new TextEncoder();
  const sse = (obj: Record<string, unknown>) =>
    encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);

  // A stream outcome is persisted exactly once. If the client disconnects
  // right after the completed write (e.g. during the final done event), the
  // resulting cancel must not append a second log entry for the same id.
  let persistedOutcome: Promise<{ log: ChatLog; usage: ChatLog["usage"]; latency: ChatLog["latency"] }> | null = null;

  function persistStreamOutcome(
    status: ChatLog["status"],
    error?: string,
  ): Promise<{ log: ChatLog; usage: ChatLog["usage"]; latency: ChatLog["latency"] }> {
    if (persistedOutcome) return persistedOutcome;
    persistedOutcome = (async () => {
      const { usage, latency } = captureStreamOutcome(status, error);
      const log: ChatLog = {
        id: logId,
        request_id: ctx.requestId,
        status,
        session_id,
        timestamp: new Date().toISOString(),
        provider: OPENROUTER_PROVIDER,
        model,
        requested_model: requestedModel !== model ? requestedModel : undefined,
        system_prompt: system,
        messages,
        response: fullResponse,
        thinking_content: fullThinking || undefined,
        usage,
        latency,
        thinking_enabled: thinking?.enabled,
        thinking_budget: thinking?.budget_tokens,
        interaction,
        error,
      };

      await writeChatLog(log);

      return { log, usage, latency };
    })();
    return persistedOutcome;
  }

  const readable = new ReadableStream({
    async start(controller) {
      upstreamReader = upstream.body!.getReader();
      const reader = upstreamReader;
      const decoder = new TextDecoder();
      let buffer = "";
      let streamIdleTimeout: ReturnType<typeof setTimeout> | null = null;

      const enqueue = (obj: Record<string, unknown>) => {
        if (clientCancelled) throw new StreamCancelledError();
        try {
          controller.enqueue(sse(obj));
        } catch {
          cancelUpstream("client_cancelled");
          throw new StreamCancelledError();
        }
      };

      const clearStreamIdleTimeout = () => {
        if (streamIdleTimeout) {
          clearTimeout(streamIdleTimeout);
          streamIdleTimeout = null;
        }
      };
      const resetStreamIdleTimeout = () => {
        clearStreamIdleTimeout();
        streamIdleTimeout = setTimeout(() => {
          timeoutUpstream(
            `OpenRouter stream timed out after ${formatTimeoutMs(OPENROUTER_STREAM_IDLE_TIMEOUT_MS)} without data`,
          );
        }, OPENROUTER_STREAM_IDLE_TIMEOUT_MS);
      };

      try {
        resetStreamIdleTimeout();
        while (true) {
          if (clientCancelled) throw new StreamCancelledError();
          const { done, value } = await reader.read();
          if (upstreamTimedOut) throw new UpstreamTimeoutError(upstreamTimeoutMessage);
          if (done) break;
          if (clientCancelled) throw new StreamCancelledError();
          resetStreamIdleTimeout();
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
              enqueue({ type: "delta", text });
            }

            const thinkingDelta = extractThinkingDelta(delta as Record<string, unknown>);
            if (thinkingDelta) {
              ttfThinking ??= performance.now() - t0;
              fullThinking += thinkingDelta;
              enqueue({ type: "thinking_delta", thinking: thinkingDelta });
            }
          }
        }

        if (clientCancelled) throw new StreamCancelledError();
        if (upstreamTimedOut) throw new UpstreamTimeoutError(upstreamTimeoutMessage);
        clearStreamIdleTimeout();

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

        const { usage, latency } = await persistStreamOutcome("completed");

        logger.info("chat.stream.complete", {
          request_id: ctx.requestId,
          log_id: logId,
          session_id,
          model,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens,
          total_time_ms: latency.total_time_ms,
          time_to_first_token_ms: latency.time_to_first_token_ms,
          response_chars: fullResponse.length,
          thinking_chars: fullThinking.length || undefined,
        });

        enqueue({ type: "done", usage, latency });
      } catch (error) {
        const timedOut = upstreamTimedOut || isUpstreamTimeoutError(error);
        const cancelled = !timedOut && (clientCancelled || isAbortLikeError(error));
        const msg = timedOut
          ? upstreamTimeoutMessage || "OpenRouter stream timed out"
          : cancelled
          ? "Stream cancelled"
          : error instanceof Error ? error.message : "Unknown error";
        const { latency } = await persistStreamOutcome(
          cancelled ? "cancelled" : "failed",
          cancelled ? "cancelled by client" : msg,
        );

        const event = timedOut ? "chat.stream.timeout" : cancelled ? "chat.stream.cancelled" : "chat.stream.failed";
        const logLevel: LogLevel = timedOut ? "warn" : cancelled ? "info" : "error";
        logger[logLevel](event, {
          request_id: ctx.requestId,
          log_id: logId,
          session_id,
          model,
          total_time_ms: latency.total_time_ms,
          response_chars: fullResponse.length,
          thinking_chars: fullThinking.length || undefined,
          timeout_ms: timedOut ? OPENROUTER_STREAM_IDLE_TIMEOUT_MS : undefined,
          error: cancelled ? undefined : errorDetails(error),
        });

        if (!cancelled) {
          try {
            controller.enqueue(sse({ type: "error", error: msg }));
          } catch {
            cancelUpstream("client_cancelled");
          }
        }
      } finally {
        clearStreamIdleTimeout();
        req.signal.removeEventListener("abort", abortUpstream);
        try {
          reader.releaseLock();
        } catch {
          // The reader may already be released after cancellation.
        }
        upstreamReader = null;
        try {
          controller.close();
        } catch {
          // The client may have already closed the stream.
        }
      }
    },
    cancel(reason) {
      cancelUpstream(reason);
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
  let files: string[];
  try {
    files = await readdir(CHATS_DIR);
  } catch (error) {
    logger.warn("chats.list_failed", {
      path: CHATS_DIR,
      error: errorDetails(error),
    });
    return jsonResponse({ chats: [] });
  }

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
    } catch (error) {
      logger.warn("chats.list_skip_invalid_file", {
        file,
        error: errorDetails(error),
      });
    }
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

  if (!body || typeof body !== "object") {
    return errorResponse("Invalid request body");
  }
  const b = body as Record<string, unknown>;

  if (!b.sessionId || typeof b.sessionId !== "string") {
    return errorResponse("sessionId is required");
  }
  const parsedMessages = validateMessages(b.messages);
  if (!parsedMessages.ok) return errorResponse(parsedMessages.error);

  const id = (typeof b.id === "string" && CHAT_ID_RE.test(b.id)) ? b.id : crypto.randomUUID();
  const now = new Date().toISOString();
  const tree = sanitizeChatTree(b.tree);

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
          messages: parsedMessages.messages,
          tree: tree ?? existing.tree,
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
          messages: parsedMessages.messages,
          tree,
        };

    await atomicWrite(chatPath(id), JSON.stringify(chat, null, 2));

    logger.info("chat.saved", {
      chat_id: chat.id,
      message_count: chat.messages.length,
      model: chat.model,
      created: !existing,
    });

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
  const nextTitle = typeof title === "string" ? title.trim() : "";
  if (!nextTitle) {
    return errorResponse("title is required");
  }

  const release = await mutexFor(id).acquire();
  try {
    const chat = await readChat(id);
    if (!chat) return notFound("Chat not found");

    chat.title = nextTitle;
    chat.updatedAt = new Date().toISOString();
    await atomicWrite(chatPath(id), JSON.stringify(chat, null, 2));

    logger.info("chat.renamed", {
      chat_id: chat.id,
      title_chars: chat.title.length,
    });

    return jsonResponse({ id: chat.id, title: chat.title, updatedAt: chat.updatedAt });
  } finally {
    release();
  }
}

async function handleDuplicateChat(id: string): Promise<Response> {
  const err = validateChatId(id);
  if (err) return errorResponse(err);

  const sourceRelease = await mutexFor(id).acquire();
  let source: SavedChat | null;
  try {
    source = await readChat(id);
  } finally {
    sourceRelease();
  }
  if (!source) return notFound("Chat not found");

  const duplicateId = crypto.randomUUID();
  const now = new Date().toISOString();
  const duplicate: SavedChat = {
    ...source,
    id: duplicateId,
    title: `${source.title || "New Chat"} (copy)`,
    createdAt: now,
    updatedAt: now,
    sessionId: crypto.randomUUID(),
    messages: source.messages.map((message) => ({ ...message })),
  };

  const release = await mutexFor(duplicateId).acquire();
  try {
    await atomicWrite(chatPath(duplicateId), JSON.stringify(duplicate, null, 2));
  } finally {
    release();
  }

  logger.info("chat.duplicated", {
    chat_id: id,
    duplicate_chat_id: duplicateId,
    message_count: duplicate.messages.length,
  });

  return jsonResponse(duplicate);
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
    logger.info("chat.deleted", { chat_id: id });
    return jsonResponse({ success: true });
  } finally {
    release();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Shape-check the branch tree before persisting so a malformed payload can't
// corrupt the saved file. The client is the source of truth for branch
// semantics, so this stays a shallow guard rather than a deep validation.
function sanitizeChatTree(value: unknown): ChatTree | undefined {
  if (!value || typeof value !== "object") return undefined;
  const t = value as Record<string, unknown>;
  if (!t.nodes || typeof t.nodes !== "object") return undefined;
  if (!Array.isArray(t.rootChildren)) return undefined;

  return {
    version: typeof t.version === "number" ? t.version : 1,
    rootChildren: t.rootChildren.filter((id): id is string => typeof id === "string"),
    activeRootId: typeof t.activeRootId === "string" ? t.activeRootId : null,
    nodes: t.nodes as Record<string, ChatTreeNode>,
  };
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
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const STATIC_CACHE = "no-cache";

async function serveStatic(pathname: string): Promise<Response> {
  let requestedPath: string;
  try {
    requestedPath = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  } catch {
    return errorResponse("Invalid path");
  }

  if (requestedPath.includes("\0")) return notFound();

  const filePath = resolve(PUBLIC_DIR, `.${requestedPath}`);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    logger.warn("static.path_traversal_blocked", { pathname });
    return notFound();
  }

  const file = Bun.file(filePath);

  if (!(await file.exists())) return notFound();

  const ext = extname(filePath);
  return new Response(file, {
    headers: {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": STATIC_CACHE,
    },
  });
}

// ── Router ──────────────────────────────────────────────────────────────────

type Handler = (req: Request, params: Record<string, string>, ctx: RequestContext) => Promise<Response>;

interface Route {
  method: string;
  pattern: URLPattern;
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  return { method, pattern: new URLPattern({ pathname: path }), handler };
}

const routes: Route[] = [
  route("POST", "/api/chat",       (req, _params, ctx) => handleStream(req, ctx)),
  route("GET",  "/api/models",     (req) => handleModels(req)),
  route("GET",  "/api/themes",     (req) => handleThemes(req)),
  route("GET",  "/api/themes/:id.css", (_req, p) => handleThemeCss(p.id)),
  route("GET",  "/api/chats",      ()    => handleListChats()),
  route("POST", "/api/chats",      (req) => handleSaveChat(req)),
  route("POST", "/api/chats/:id/duplicate", (_req, p) => handleDuplicateChat(p.id)),
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
    const url = new URL(req.url);
    const ctx: RequestContext = {
      requestId: crypto.randomUUID(),
      method: req.method,
      pathname: url.pathname,
      startedAt: performance.now(),
    };

    let response: Response;
    try {
      response = await routeRequest(req, ctx);
    } catch (error) {
      logger.error("request.unhandled_error", {
        request_id: ctx.requestId,
        method: ctx.method,
        path: ctx.pathname,
        error: errorDetails(error),
      });
      response = errorResponse("Internal server error", 500);
    }

    const durationMs = Math.round(performance.now() - ctx.startedAt);
    const level: LogLevel = response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info";
    logger[level]("request.completed", {
      request_id: ctx.requestId,
      method: ctx.method,
      path: ctx.pathname,
      status: response.status,
      duration_ms: durationMs,
    });

    response.headers.set("X-Request-Id", ctx.requestId);
    return response;
  },
});

async function routeRequest(req: Request, ctx: RequestContext): Promise<Response> {
  for (const r of routes) {
    if (r.method !== ctx.method) continue;
    const match = r.pattern.exec(req.url);
    if (!match) continue;
    return r.handler(req, (match.pathname.groups || {}) as Record<string, string>, ctx);
  }

  return serveStatic(ctx.pathname);
}

logger.info("server.started", {
  url: `http://localhost:${server.port}`,
  port: server.port,
  logs_dir: LOGS_DIR,
  chats_dir: CHATS_DIR,
  openrouter_base_url: OPENROUTER_API_BASE,
  langfuse_enabled: langfuse.enabled,
  langfuse_environment: langfuse.enabled ? LANGFUSE_ENVIRONMENT : undefined,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("server.stopping", { signal });
  server.stop(true);
  await langfuse.shutdown();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
