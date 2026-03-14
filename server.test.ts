import { expect, test, describe } from "bun:test";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";

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

describe("Chat API", () => {
  test("GET /api/models returns OpenRouter model catalog", async () => {
    const res = await fetch(`${BASE_URL}/api/models`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.provider).toBe("openrouter");
    expect(Array.isArray(data.models)).toBe(true);
    expect(data.models.length).toBeGreaterThan(0);
    expect(typeof data.models[0].id).toBe("string");
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
    expect(text).toContain("<!DOCTYPE html>");
  });

  test("GET /styles.css serves CSS", async () => {
    const res = await fetch(`${BASE_URL}/styles.css`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("POST /api/chat streams response", async () => {
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

    // Read SSE stream
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let receivedData = false;

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        if (chunk.includes("data:")) {
          receivedData = true;
          // Check for delta or done event
          expect(chunk).toMatch(/data: \{.*"type":/);
        }
      }
    }

    expect(receivedData).toBe(true);
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
});
