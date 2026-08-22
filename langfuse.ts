import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  createTraceId,
  LangfuseGeneration,
  LangfuseSpan,
  propagateAttributes,
  startObservation,
} from "@langfuse/tracing";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

type LogContext = Record<string, unknown>;

interface TelemetryLogger {
  debug(event: string, context?: LogContext): void;
  warn(event: string, context?: LogContext): void;
}

export interface LangfuseTracingConfig {
  enabled: boolean;
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  requestTimeoutMs: number;
  environment: string;
  logger: TelemetryLogger;
}

/**
 * Fork context for a chat turn. The client owns the branch tree; when a turn
 * retries a reply or re-sends an edited prompt, the new attempt is a sibling
 * of the old one. These values let Langfuse traces express that relationship
 * (tags are immutable, so they must be set at trace creation).
 */
export interface ChatInteractionContext {
  kind: "send" | "continue" | "retry" | "edit_resend";
  chatId?: string;
  assistantNodeId?: string;
  branchedFromNodeId?: string;
  siblingIndex?: number;
  siblingCount?: number;
  pathLength?: number;
}

export interface ModelPricing {
  /** USD per token. */
  prompt?: number;
  completion?: number;
  input_cache_read?: number;
  input_cache_write?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface LangfuseChatTraceInput {
  logId: string;
  requestId: string;
  sessionId: string;
  provider: string;
  requestedModel: string;
  model: string;
  systemPrompt: string;
  messages: unknown[];
  upstreamMessages: unknown[];
  modelParameters: Record<string, unknown>;
  thinkingRequested: boolean;
  thinkingEnabled: boolean;
  interaction?: ChatInteractionContext;
  pricing?: ModelPricing;
  startTime: Date;
}

export interface LangfuseChatTraceOutcome {
  status: "completed" | "failed" | "cancelled";
  response: string;
  thinking?: string;
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
  completionStartTime?: Date;
  endTime: Date;
  error?: string;
}

function modelProvider(modelId: string): string {
  const [provider] = modelId.split("/");
  return provider || "unknown";
}

function observationLevel(
  status: LangfuseChatTraceOutcome["status"],
): "DEFAULT" | "WARNING" | "ERROR" {
  if (status === "failed") return "ERROR";
  if (status === "cancelled") return "WARNING";
  return "DEFAULT";
}

/**
 * Langfuse flat usage buckets must not overlap. OpenRouter's prompt token count
 * includes cache reads/writes, so subtract those details from the plain input
 * bucket while retaining the provider's inclusive total.
 */
export function langfuseUsageDetails(
  usage: LangfuseChatTraceOutcome["usage"],
): Record<string, number> {
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreation = usage.cache_creation_input_tokens || 0;
  const details: Record<string, number> = {
    input: Math.max(0, usage.input_tokens - cacheRead - cacheCreation),
    output: usage.output_tokens,
    total: usage.input_tokens + usage.output_tokens,
  };

  if (cacheRead > 0) details.cache_read_input_tokens = cacheRead;
  if (cacheCreation > 0) details.cache_creation_input_tokens = cacheCreation;
  return details;
}

/**
 * Explicit cost breakdown (USD) from OpenRouter's per-token pricing. Passing
 * costDetails keeps cost tracking correct even when Langfuse has no built-in
 * pricing for a given OpenRouter model. Input-side cost includes cached-token
 * components so `total` matches what OpenRouter charges.
 */
export function langfuseCostDetails(
  pricing: ModelPricing | undefined,
  usage: LangfuseChatTraceOutcome["usage"],
): Record<string, number> | undefined {
  if (!pricing) return undefined;

  const promptRate = numOr(pricing.prompt, undefined);
  const completionRate = numOr(pricing.completion, undefined);
  const cacheReadRate = numOr(
    pricing.input_cache_read ?? pricing.cache_read,
    promptRate,
  );
  const cacheWriteRate = numOr(
    pricing.input_cache_write ?? pricing.cache_write,
    promptRate,
  );

  if (promptRate === undefined && completionRate === undefined) {
    return undefined;
  }

  const p = promptRate ?? 0;
  const c = completionRate ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const uncachedInput = Math.max(0, usage.input_tokens - cacheRead - cacheWrite);

  const inputCost =
    uncachedInput * p +
    cacheRead * (cacheReadRate ?? p) +
    cacheWrite * (cacheWriteRate ?? p);  const outputCost = usage.output_tokens * c;
  const totalCost = inputCost + outputCost;

  const details: Record<string, number> = {};
  if (inputCost > 0) details.input = inputCost;
  if (outputCost > 0) details.output = outputCost;
  if (Object.keys(details).length === 0) return undefined;
  if (totalCost > 0) details.total = totalCost;
  return details;
}

function numOr(value: unknown, fallback: number | undefined): number | undefined {
  const n = typeof value === "number" ? value : Number.parseFloat(value as string);
  return Number.isFinite(n) ? n : fallback;
}

/** Trace tags for a turn. Stable, low-cardinality, business-level dimensions. */
export function langfuseTraceTags(
  provider: string,
  upstreamProvider: string,
  thinkingEnabled: boolean,
  interaction?: ChatInteractionContext,
): string[] {
  const tags = ["local-chat", "chat", provider, upstreamProvider];
  if (thinkingEnabled) tags.push("thinking");
  if (interaction?.kind === "retry") tags.push("fork", "fork-retry");
  else if (interaction?.kind === "edit_resend") tags.push("fork", "fork-edit-resend");
  else if (interaction?.kind === "continue") tags.push("continue");
  return tags;
}

function interactionMetadata(
  interaction: ChatInteractionContext | undefined,
): Record<string, string> {
  if (!interaction) return {};
  const meta: Record<string, string> = { interaction_kind: interaction.kind };
  if (interaction.chatId) meta.chat_id = interaction.chatId;
  if (interaction.assistantNodeId) meta.assistant_node_id = interaction.assistantNodeId;
  if (interaction.branchedFromNodeId) meta.branched_from_node_id = interaction.branchedFromNodeId;
  if (typeof interaction.siblingIndex === "number") {
    meta.sibling_index = String(interaction.siblingIndex);
  }
  if (typeof interaction.siblingCount === "number") {
    meta.sibling_count = String(interaction.siblingCount);
  }
  if (typeof interaction.pathLength === "number") {
    meta.path_length = String(interaction.pathLength);
  }
  return meta;
}

function langfuseModelParameters(
  parameters: Record<string, unknown>,
): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(parameters).flatMap(([key, value]) => {
      if (typeof value === "string" || typeof value === "number") return [[key, value]];
      if (typeof value === "boolean") return [[key, String(value)]];
      return [];
    }),
  );
}

/**
 * Root-span input in standard role/content message format so Langfuse renders
 * it as a conversation instead of a JSON blob. The new user turn is last.
 */
function chatConversationInput(
  systemPrompt: string,
  messages: unknown[],
): Array<Record<string, unknown>> {
  const conversation: Array<Record<string, unknown>> = [];
  if (systemPrompt) conversation.push({ role: "system", content: systemPrompt });
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const m = message as Record<string, unknown>;
    if (typeof m.role !== "string") continue;
    conversation.push({
      role: m.role,
      ...(typeof m.content === "string" ? { content: m.content } : {}),
    });
  }
  return conversation;
}

class LangfuseChatTrace {
  readonly traceId: string;
  private ended = false;

  constructor(
    private readonly root: LangfuseSpan,
    private readonly generation: LangfuseGeneration,
    private readonly requestId: string,
    private readonly flush: () => void,
  ) {
    this.traceId = root.traceId;
  }

  finish(
    outcome: LangfuseChatTraceOutcome,
    pricing?: ModelPricing,
    options?: { deferFlush?: boolean },
  ): void {
    if (this.ended) return;
    this.ended = true;

    const level = observationLevel(outcome.status);
    const statusMessage = outcome.error
      || (outcome.status === "cancelled" ? "cancelled by client" : undefined);
    const output = {
      role: "assistant",
      content: outcome.response,
      ...(outcome.thinking ? { reasoning: outcome.thinking } : {}),
    };
    const outcomeMetadata = {
      status: outcome.status,
      time_to_first_token_ms: outcome.latency.time_to_first_token_ms,
      total_time_ms: outcome.latency.total_time_ms,
      time_to_first_thinking_ms: outcome.latency.time_to_first_thinking_ms,
      response_chars: outcome.response.length,
      reasoning_chars: outcome.thinking?.length || 0,
    };

    this.generation.update({
      output,
      usageDetails: langfuseUsageDetails(outcome.usage),
      costDetails: langfuseCostDetails(pricing, outcome.usage),
      completionStartTime: outcome.completionStartTime,
      level,
      statusMessage,
      metadata: outcomeMetadata,
    });
    this.root.update({
      output,
      level,
      statusMessage,
      metadata: outcomeMetadata,
    });

    this.generation.end(outcome.endTime);
    this.root.end(outcome.endTime);
    if (!options?.deferFlush) this.flush();
  }
}

export class LangfuseTracing {
  private readonly processor: LangfuseSpanProcessor | null;
  private readonly provider: NodeTracerProvider | null;

  constructor(private readonly config: LangfuseTracingConfig) {
    if (!this.enabled) {
      this.processor = null;
      this.provider = null;
      return;
    }

    this.processor = new LangfuseSpanProcessor({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
      environment: config.environment,
      timeout: Math.max(1, Math.ceil(config.requestTimeoutMs / 1_000)),
    });
    this.provider = new NodeTracerProvider({
      spanProcessors: [this.processor],
    });
    this.provider.register();
  }

  get enabled(): boolean {
    return this.config.enabled && Boolean(this.config.publicKey && this.config.secretKey);
  }

  startChatTrace(input: LangfuseChatTraceInput): Promise<LangfuseChatTrace | undefined> {
    if (!this.processor) return Promise.resolve(undefined);

    // Deterministic trace id: live pushes and backfill replays of the same
    // log entry converge on one trace instead of duplicating it.
    const spanIdSeed = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    return createTraceId(`local-chat:${input.logId}`).then((traceId) => this.openTrace(input, traceId, spanIdSeed));
  }

  private openTrace(
    input: LangfuseChatTraceInput,
    traceId: string,
    rootSpanId: string,
  ): LangfuseChatTrace | undefined {
    const upstreamProvider = modelProvider(input.model);
    let root: LangfuseSpan | undefined;
    let generation: LangfuseGeneration | undefined;
    const propagatedMetadata = interactionMetadata(input.interaction);

    propagateAttributes(
      {
        sessionId: input.sessionId,
        traceName: "local-chat.chat",
        tags: langfuseTraceTags(
          input.provider,
          upstreamProvider,
          input.thinkingEnabled,
          input.interaction,
        ),
        metadata: {
          request_id: input.requestId,
          log_id: input.logId,
          provider: input.provider,
          upstream_provider: upstreamProvider,
          resolved_model: input.model,
          ...propagatedMetadata,
        },
      },
      () => {
        root = startObservation(
          "chat.request",
          {
            input: chatConversationInput(input.systemPrompt, input.messages),
            metadata: {
              request_id: input.requestId,
              log_id: input.logId,
              endpoint: "/api/chat",
              provider: input.provider,
              upstream_provider: upstreamProvider,
              requested_model: input.requestedModel,
              resolved_model: input.model,
              message_count: input.messages.length,
              thinking_requested: input.thinkingRequested,
              thinking_enabled: input.thinkingEnabled,
              ...propagatedMetadata,
            },
          },
          {
            startTime: input.startTime,
            parentSpanContext: {
              traceId,
              spanId: rootSpanId,
              traceFlags: 1,
            },
          },
        );
        generation = root.startObservation(
          "openrouter.chat.completions",
          {
            input: input.upstreamMessages,
            model: input.model,
            modelParameters: langfuseModelParameters(input.modelParameters),
            metadata: {
              provider: input.provider,
              upstream_provider: upstreamProvider,
              requested_model: input.requestedModel,
              resolved_model: input.model,
              streaming: true,
              thinking_requested: input.thinkingRequested,
              thinking_enabled: input.thinkingEnabled,
            },
          },
          { asType: "generation" },
        );
      },
    );

    if (!root || !generation) return undefined;
    return new LangfuseChatTrace(root, generation, input.requestId, () => this.flush(input.requestId));
  }

  private flush(requestId: string): void {
    if (!this.processor) return;
    void this.processor.forceFlush().then(
      () => this.config.logger.debug("langfuse.trace_written", { request_id: requestId }),
      (error) => this.config.logger.warn("langfuse.export_error", {
        request_id: requestId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  /** Flush all buffered spans (used by the backfill script's batching). */
  async flushAll(): Promise<void> {
    if (!this.processor) return;
    await this.processor.forceFlush();
  }

  async shutdown(): Promise<void> {
    if (!this.provider) return;
    try {
      await this.provider.shutdown();
    } catch (error) {
      this.config.logger.warn("langfuse.shutdown_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
