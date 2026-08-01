import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
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

  finish(outcome: LangfuseChatTraceOutcome): void {
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
    this.flush();
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

  startChatTrace(input: LangfuseChatTraceInput): LangfuseChatTrace | undefined {
    if (!this.processor) return undefined;

    const upstreamProvider = modelProvider(input.model);
    let root: LangfuseSpan | undefined;
    let generation: LangfuseGeneration | undefined;

    propagateAttributes(
      {
        sessionId: input.sessionId,
        traceName: "local-chat.chat",
        tags: ["local-chat", "chat", "streaming", input.provider, upstreamProvider],
        metadata: {
          request_id: input.requestId,
          log_id: input.logId,
          provider: input.provider,
          upstream_provider: upstreamProvider,
          resolved_model: input.model,
        },
      },
      () => {
        root = startObservation(
          "chat.request",
          {
            input: {
              system: input.systemPrompt,
              messages: input.messages,
            },
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
            },
          },
          { startTime: input.startTime },
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
