import { expect, test, describe } from "bun:test";

const BASE_URL = "http://localhost:3000";

describe("Chat API", () => {
  test("GET /api/models returns available models and providers", async () => {
    const res = await fetch(`${BASE_URL}/api/models`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.models).toContain("claude-opus-4-6");
    expect(data.models).toContain("claude-opus-4-5-20251101");
    expect(data.models).toContain("claude-sonnet-4-6");
    expect(data.models).toContain("claude-sonnet-4-5-20250929");
    expect(data.models).toContain("claude-haiku-4-5-20251001");
    expect(Array.isArray(data.providers)).toBe(true);
    expect(data.providers.length).toBeGreaterThan(0);
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
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
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

  test("POST /api/chat returns 400 for invalid model", async () => {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "invalid-model",
        system: "",
        messages: [{ role: "user", content: "Test" }],
        session_id: "test-session-123",
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid model");
  });

  test("POST /api/chat returns 400 for invalid messages", async () => {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
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
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
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
