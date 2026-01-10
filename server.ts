import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const MODELS = [
  "claude-opus-4-5-20250514",
  "claude-sonnet-4-20250514",
  "claude-haiku-3-5-20241022",
] as const;

type Model = (typeof MODELS)[number];

interface ChatRequest {
  model: Model;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

function validateRequest(body: unknown): { valid: true; data: ChatRequest } | { valid: false; error: string } {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Invalid request body" };
  }

  const { model, system, messages } = body as Record<string, unknown>;

  // Validate model
  if (!model || !MODELS.includes(model as Model)) {
    return { valid: false, error: `Invalid model. Must be one of: ${MODELS.join(", ")}` };
  }

  // Validate system (optional, must be string if provided)
  if (system !== undefined && typeof system !== "string") {
    return { valid: false, error: "System prompt must be a string" };
  }

  // Validate messages
  if (!Array.isArray(messages)) {
    return { valid: false, error: "Messages must be an array" };
  }

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      return { valid: false, error: "Each message must be an object" };
    }
    if (msg.role !== "user" && msg.role !== "assistant") {
      return { valid: false, error: "Message role must be 'user' or 'assistant'" };
    }
    if (typeof msg.content !== "string") {
      return { valid: false, error: "Message content must be a string" };
    }
  }

  return {
    valid: true,
    data: { model: model as Model, system: (system as string) || "", messages: messages as ChatRequest["messages"] },
  };
}

async function handleChat(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const validation = validateRequest(body);
  if (!validation.valid) {
    return new Response(JSON.stringify({ error: validation.error }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { model, system, messages } = validation.data;

  // Build system content with 1-hour caching
  const systemContent: Anthropic.TextBlockParam[] = system
    ? [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }]
    : [];

  // Build messages with cache control on conversation history
  // Cache the last message before the current turn to cache the entire prefix
  const formattedMessages: Anthropic.MessageParam[] = messages.map((m, i) => {
    const isLastBeforeCurrent = i === messages.length - 2;
    const content: Anthropic.ContentBlockParam[] = [
      {
        type: "text",
        text: m.content,
        ...(isLastBeforeCurrent && { cache_control: { type: "ephemeral", ttl: "1h" } }),
      },
    ];
    return { role: m.role, content };
  });

  // Stream response
  const stream = await client.messages.stream({
    model,
    max_tokens: 8192,
    system: systemContent,
    messages: formattedMessages,
  });

  // Create SSE response
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            const data = JSON.stringify({ type: "delta", text: event.delta.text });
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          } else if (event.type === "message_stop") {
            // Get final message for usage stats
            const finalMessage = await stream.finalMessage();
            const data = JSON.stringify({
              type: "done",
              usage: finalMessage.usage,
            });
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          }
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        const data = JSON.stringify({ type: "error", error: errorMsg });
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// Static file server
async function serveStatic(path: string): Promise<Response> {
  const filePath = `./public${path === "/" ? "/index.html" : path}`;
  const file = Bun.file(filePath);

  if (await file.exists()) {
    const contentType = getContentType(filePath);
    return new Response(file, { headers: { "Content-Type": contentType } });
  }

  return new Response("Not Found", { status: 404 });
}

function getContentType(path: string): string {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".js")) return "application/javascript";
  return "application/octet-stream";
}

// Main server
const server = Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);

    // API routes
    if (url.pathname === "/api/chat" && req.method === "POST") {
      return handleChat(req);
    }

    if (url.pathname === "/api/models" && req.method === "GET") {
      return Response.json({ models: MODELS });
    }

    // Static files
    return serveStatic(url.pathname);
  },
});

console.log(`Server running at http://localhost:${server.port}`);
