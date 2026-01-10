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

async function handleChat(req: Request): Promise<Response> {
  const body: ChatRequest = await req.json();
  const { model, system, messages } = body;

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
