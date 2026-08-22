#!/usr/bin/env bun
/**
 * Backfill historical chat_logs.jsonl entries into Langfuse.
 *
 * Replays every local chat log as the same trace shape the live server pushes
 * (session, conversation input, generation with usage/cost/latency, fork
 * lineage), so old turns become first-class citizens in Langfuse sessions.
 *
 * Deduplication (no duplicate traces, ever):
 *   1. Every push (live server and backfill) uses a deterministic trace id
 *      derived from the log entry id, so replaying an entry targets the same
 *      trace instead of creating a second one.
 *   2. Before pushing, the script sweeps Langfuse for existing traces and
 *      collects their `metadata.log_id` values; any local log that was already
 *      pushed live is skipped. The sweep result is cached in the progress file.
 *   3. Successfully pushed ids are recorded, so re-runs resume exactly where
 *      they stopped.
 *
 * Safe to run while the server is running and safe to re-run at any time.
 *
 * Usage:
 *   bun run backfill-langfuse.ts [--dry-run] [--limit N] [--batch N] [--fresh] [--no-sweep] [--file PATH]
 */

import { appendFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadDotEnv } from "./env";
import { logger } from "./logger";
import { LangfuseTracing } from "./langfuse";
import type { ChatInteractionContext, LangfuseChatTraceOutcome, ModelPricing } from "./langfuse";
import { buildOpenRouterMessages } from "./openrouter-messages";
import type { Message } from "./types";

loadDotEnv();

// ── CLI args ────────────────────────────────────────────────────────────────

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

const DRY_RUN = hasFlag("--dry-run");
const FRESH = hasFlag("--fresh");
/** Skip the "what already exists in Langfuse" sweep (not recommended). */
const NO_SWEEP = hasFlag("--no-sweep");
const LIMIT = Math.max(0, Number.parseInt(argValue("--limit") || "", 10) || 0);
const BATCH_SIZE = Math.max(1, Number.parseInt(argValue("--batch") || "10", 10));
const SWEEP_PAGE_SIZE = 100;
const LOGS_DIR = process.env.LOGS_DIR || "./logs";
const LOGS_FILE = resolve(argValue("--file") || `${LOGS_DIR}/chat_logs.jsonl`);
const PROGRESS_FILE = resolve(`${LOGS_DIR}/.langfuse-backfill.jsonl`);
const MODEL_CACHE_FILE = resolve(process.env.OPENROUTER_MODELS_CACHE || `${LOGS_DIR}/openrouter_models_cache.json`);

const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY || "";
const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY || "";
const LANGFUSE_BASE_URL = (process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com").replace(/\/+$/, "");
/** Generous: historical entries can be large, and uploads share one OTLP call per batch. */
const LANGFUSE_REQUEST_TIMEOUT_MS = Math.max(
  30_000,
  Number.parseInt(process.env.LANGFUSE_REQUEST_TIMEOUT_MS || "", 10) || 120_000,
);
const LANGFUSE_ENVIRONMENT = process.env.LANGFUSE_TRACING_ENVIRONMENT || "backfill";
const LANGFUSE_ENABLED = (value: string | undefined): boolean =>
  value === undefined || !["0", "false", "no", "off"].includes(value.trim().toLowerCase());

interface HistoricalChatLog {
  id: string;
  request_id?: string;
  status?: "completed" | "failed" | "cancelled";
  session_id: string;
  timestamp: string;
  provider?: string;
  model: string;
  requested_model?: string;
  system_prompt: string;
  messages: Array<{ role: string; content: string; thinking?: string }>;
  response: string;
  thinking_content?: string;
  usage?: Partial<{
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  }>;
  latency?: Partial<{
    time_to_first_token_ms: number;
    total_time_ms: number;
    time_to_first_thinking_ms: number;
  }>;
  thinking_enabled?: boolean;
  thinking_budget?: number;
  interaction?: ChatInteractionContext;
  error?: string;
}

type ProgressLine = { processedId: string } | { sweepCompletedAt: string };

interface Progress {
  processed: Set<string>;
  sweepCompletedAt?: string;
}

function readProgress(): Progress {
  if (FRESH || !existsSync(PROGRESS_FILE)) return { processed: new Set() };
  try {
    const content = readFileSync(PROGRESS_FILE, "utf8");
    const progress: Progress = { processed: new Set() };
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Partial<ProgressLine>;
        if ("processedId" in entry && entry.processedId) {
          progress.processed.add(entry.processedId);
        } else if ("sweepCompletedAt" in entry && entry.sweepCompletedAt) {
          progress.sweepCompletedAt = entry.sweepCompletedAt;
        }
      } catch {
        // Ignore torn trailing lines (e.g. after a crash mid-write).
      }
    }
    return progress;
  } catch {
    logger.warn("backfill.progress_unreadable", { path: PROGRESS_FILE });
    return { processed: new Set() };
  }
}

async function appendProgressLines(lines: ProgressLine[]): Promise<void> {
  if (lines.length === 0) return;
  await mkdir(LOGS_DIR, { recursive: true });
  const payload = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
  await appendFile(PROGRESS_FILE, payload, "utf8");
}

async function recordProcessedIds(ids: string[]): Promise<void> {
  await appendProgressLines(ids.map((id) => ({ processedId: id }) as ProgressLine));
}

async function fetchTracesPage(page: number): Promise<{
  data?: Array<{ metadata?: Record<string, unknown> }>;
  meta?: { totalPages?: number };
}> {
  const auth = `Basic ${btoa(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`)}`;
  const url =
    `${LANGFUSE_BASE_URL}/api/public/traces?limit=${SWEEP_PAGE_SIZE}&page=${page}&orderBy=timestamp.asc`;

  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { headers: { Authorization: auth } });
      if (!res.ok) throw new Error(`Langfuse traces list failed with ${res.status}`);
      return await res.json() as {
        data?: Array<{ metadata?: Record<string, unknown> }>;
        meta?: { totalPages?: number };
      };
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      const backoffMs = 1_000 * attempt;
      logger.warn("backfill.sweep.retry", {
        page,
        attempt,
        next_attempt_ms: backoffMs,
        error: error instanceof Error ? error.message : String(error),
      });
      await Bun.sleep(backoffMs);
    }
  }
  throw new Error("unreachable");
}

/**
 * Page through all traces in Langfuse and collect their `metadata.log_id`
 * values. Any local log id that shows up here was already pushed (live or by a
 * previous backfill run) and must be skipped to avoid duplicates.
 */
async function sweepExistingTraceLogIds(): Promise<Set<string>> {
  const found = new Set<string>();
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const data = await fetchTracesPage(page);

    for (const trace of data.data ?? []) {
      const logId = trace.metadata?.log_id;
      if (typeof logId === "string" && logId.length > 0) found.add(logId);
    }

    totalPages = data.meta?.totalPages ?? 1;
    page += 1;
  }

  return found;
}

/** Pricing snapshot by model id from the cached OpenRouter catalog (best effort). */
function pricingLookup(): (modelId: string) => ModelPricing | undefined {
  const byId = new Map<string, ModelPricing>();
  try {
    const data = JSON.parse(readFileSync(MODEL_CACHE_FILE, "utf8")) as {
      models?: Array<Record<string, unknown>>;
    };
    for (const model of data.models ?? []) {
      if (typeof model.id !== "string") continue;
      const pricing = model.pricing as Record<string, string> | undefined;
      if (!pricing) continue;

      const num = (v: unknown): number | undefined => {
        const n = typeof v === "number" ? v : Number.parseFloat(v as string);
        return Number.isFinite(n) ? n : undefined;
      };
      const prompt = num(pricing.prompt);
      const completion = num(pricing.completion);
      if (prompt === undefined && completion === undefined) continue;

      const entry: ModelPricing = {};
      const set = (key: keyof ModelPricing, value: unknown) => {
        const parsed = num(value);
        if (parsed !== undefined) entry[key] = parsed;
      };
      set("prompt", pricing.prompt);
      set("completion", pricing.completion);
      set("input_cache_read", pricing.input_cache_read);
      set("input_cache_write", pricing.input_cache_write);
      set("cache_read", pricing.cache_read);
      set("cache_write", pricing.cache_write);
      byId.set(model.id, entry);
    }
  } catch {
    logger.warn("backfill.model_cache_unavailable", { path: MODEL_CACHE_FILE });
  }

  return (modelId: string) => byId.get(modelId);
}

function normalizeUsage(raw: HistoricalChatLog["usage"]): LangfuseChatTraceOutcome["usage"] {
  return {
    input_tokens: raw?.input_tokens ?? 0,
    output_tokens: raw?.output_tokens ?? 0,
    ...(raw?.cache_creation_input_tokens
      ? { cache_creation_input_tokens: raw.cache_creation_input_tokens }
      : {}),
    ...(raw?.cache_read_input_tokens ? { cache_read_input_tokens: raw.cache_read_input_tokens } : {}),
  };
}

/**
 * Reconstruct stream timings from the recorded end timestamp and latencies:
 * start = end - total_time_ms, completion starts at first token.
 */
function timingFor(log: HistoricalChatLog): {
  startTime: Date;
  completionStartTime: Date | undefined;
  endTime: Date;
} {
  const endTimeMs = Number.isFinite(Date.parse(log.timestamp))
    ? Date.parse(log.timestamp)
    : Date.now();
  const totalMs = Math.max(0, log.latency?.total_time_ms ?? 0);
  const ttftMs = Math.min(
    totalMs,
    Math.max(0, log.latency?.time_to_first_token_ms ?? 0),
  );

  const endTime = new Date(endTimeMs);
  return {
    startTime: new Date(endTimeMs - totalMs),
    completionStartTime: log.latency?.time_to_first_token_ms !== undefined
      ? new Date(endTimeMs - totalMs + ttftMs)
      : undefined,
    endTime,
  };
}

async function main(): Promise<number> {
  if (!LANGFUSE_ENABLED(process.env.LANGFUSE_ENABLED)) {
    logger.error("backfill.disabled", { message: "LANGFUSE_ENABLED=0" });
    return 2;
  }
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
    logger.error("backfill.missing_credentials", { message: "Set LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY" });
    return 2;
  }
  if (!existsSync(LOGS_FILE)) {
    logger.error("backfill.logs_missing", { path: LOGS_FILE });
    return 2;
  }

  const langfuse = new LangfuseTracing({
    enabled: true,
    publicKey: LANGFUSE_PUBLIC_KEY,
    secretKey: LANGFUSE_SECRET_KEY,
    baseUrl: LANGFUSE_BASE_URL,
    requestTimeoutMs: LANGFUSE_REQUEST_TIMEOUT_MS,
    environment: LANGFUSE_ENVIRONMENT,
    logger,
  });

  if (DRY_RUN) {
    logger.info("backfill.dry_run", { file: LOGS_FILE });
  }

  const pricingFor = pricingLookup();
  const progress = readProgress();
  const processed = progress.processed;
  const counters = { pushed: 0, skipped: 0, failed: 0, malformed: 0 };

  // Skip anything already in Langfuse (pushed live or by a previous run).
  // Deterministic trace ids are the second line of defense; this sweep is the
  // first, covering entries pushed before deterministic ids existed.
  if (!NO_SWEEP && !progress.sweepCompletedAt) {
    logger.info("backfill.sweep.start", { base_url: LANGFUSE_BASE_URL });
    try {
      const existingLogIds = await sweepExistingTraceLogIds();
      const newlySeen = [...existingLogIds].filter((id) => !processed.has(id));
      for (const id of existingLogIds) processed.add(id);
      if (!DRY_RUN) {
        await recordProcessedIds(newlySeen);
        await appendProgressLines([{ sweepCompletedAt: new Date().toISOString() }]);
      }
      logger.info("backfill.sweep.complete", {
        existing_traces_with_log_id: existingLogIds.size,
        skipped_as_duplicates: existingLogIds.size,
        cached_at: DRY_RUN ? undefined : new Date().toISOString(),
      });
    } catch (error) {
      logger.warn("backfill.sweep.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!DRY_RUN) {
        logger.error("backfill.abort_no_sweep", {
          message: "Refusing to push without a successful dedup sweep; fix access or pass --no-sweep.",
        });
        return 2;
      }
    }
  } else {
    logger.info("backfill.sweep.skipped", {
      reason: NO_SWEEP ? "flag" : "cached",
      cached_at: !NO_SWEEP ? progress.sweepCompletedAt : undefined,
    });
  }

  const lines = createInterface({
    input: createReadStream(LOGS_FILE, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  type Pending = { id: string; work: Promise<void> };
  let batch: Pending[] = [];

  /**
   * Flush with one retry. Progress is only recorded after a successful flush,
   * so an entry is never marked done before its trace reached Langfuse. If the
   * server ingested the batch despite a timeout, the deterministic trace ids
   * make any later replay converge on the same traces instead of duplicating.
   */
  const flushWithRetry = async (): Promise<boolean> => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await langfuse.flushAll();
        return true;
      } catch (error) {
        logger.warn("backfill.flush_retry", {
          attempt,
          batch_ids: batch.map((entry) => entry.id).slice(0, 3),
          error: error instanceof Error ? error.message : String(error),
        });
        await Bun.sleep(2_000 * attempt);
      }
    }
    return false;
  };

  const drainBatch = async (): Promise<boolean> => {
    if (batch.length === 0) return true;
    await Promise.all(batch.map((entry) => entry.work));
    if (!(await flushWithRetry())) {
      logger.error("backfill.abort_flush_failed", {
        message: "Batch did not reach Langfuse; aborting without recording progress. Re-run to resume.",
        pending_ids: batch.map((entry) => entry.id),
      });
      return false;
    }
    await recordProcessedIds(batch.map((entry) => entry.id));
    batch = [];
    logger.info("backfill.progress", {
      pushed: counters.pushed,
      skipped: counters.skipped,
      failed: counters.failed,
      total_lines: counters.pushed + counters.skipped + counters.failed + counters.malformed,
    });
    return true;
  };

  const pushLog = async (log: HistoricalChatLog) => {
    try {
      // Old-format entries predate request_id/status/provider.
      const requestId = log.request_id || log.id;
      const status = log.status ?? (log.error ? "failed" : "completed");
      const provider = log.provider || "openrouter";
      const requestedModel = log.requested_model || log.model;
      const { startTime, completionStartTime, endTime } = timingFor(log);
      const latency = {
        time_to_first_token_ms: log.latency?.time_to_first_token_ms ?? 0,
        total_time_ms: log.latency?.total_time_ms ?? 0,
        ...(log.latency?.time_to_first_thinking_ms !== undefined
          ? { time_to_first_thinking_ms: log.latency.time_to_first_thinking_ms }
          : {}),
      };

      const trace = await langfuse.startChatTrace({
        logId: log.id,
        requestId,
        sessionId: log.session_id,
        provider,
        requestedModel,
        model: log.model,
        systemPrompt: log.system_prompt,
        messages: log.messages,
        // Reconstruct the upstream payload shape from the stored conversation
        // (exact historical request bodies were not logged).
        upstreamMessages: buildOpenRouterMessages(log.system_prompt, log.messages as Message[]),
        modelParameters: {
          ...(log.thinking_budget !== undefined ? { thinking_budget: log.thinking_budget } : {}),
        },
        thinkingRequested: log.thinking_enabled === true,
        thinkingEnabled: Boolean(log.thinking_content),
        ...(log.interaction ? { interaction: log.interaction } : {}),
        ...(pricingFor(log.model) ? { pricing: pricingFor(log.model) } : {}),
        startTime,
      });

      if (!trace) {
        counters.failed++;
        return;
      }

      trace.finish(
        {
          status,
          response: log.response || "",
          thinking: log.thinking_content,
          usage: normalizeUsage(log.usage),
          latency,
          completionStartTime,
          endTime,
          error: log.error,
        },
        pricingFor(log.model),
        { deferFlush: true },
      );
      counters.pushed++;
    } catch (error) {
      counters.failed++;
      logger.warn("backfill.entry_failed", {
        log_id: log.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  for await (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    let log: HistoricalChatLog;
    try {
      log = JSON.parse(trimmedLine) as HistoricalChatLog;
    } catch {
      counters.malformed++;
      continue;
    }
    if (!log?.id || !Array.isArray(log.messages)) {
      counters.malformed++;
      continue;
    }
    if (processed.has(log.id)) {
      counters.skipped++;
      continue;
    }
    if (LIMIT > 0 && counters.pushed >= LIMIT) break;

    if (DRY_RUN) {
      counters.pushed++;
      continue;
    }

    batch.push({ id: log.id, work: pushLog(log) });
    if (batch.length >= BATCH_SIZE) {
      if (!(await drainBatch())) return 1;
    }
  }

  if (!(await drainBatch())) return 1;
  lines.close();
  await langfuse.shutdown();

  logger.info("backfill.complete", {
    dry_run: DRY_RUN || undefined,
    file: LOGS_FILE,
    pushed: counters.pushed,
    skipped_already_processed: counters.skipped,
    failed: counters.failed || undefined,
    malformed: counters.malformed || undefined,
  });

  return counters.failed > 0 ? 1 : 0;
}

process.exitCode = await main();
