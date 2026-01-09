import { expect, test, describe } from "bun:test";

const BASE_URL = "http://localhost:3000";

describe("Chat API", () => {
  test("GET /api/models returns available models", async () => {
    const res = await fetch(`${BASE_URL}/api/models`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.models).toContain("claude-opus-4-5-20250514");
    expect(data.models).toContain("claude-sonnet-4-20250514");
    expect(data.models).toContain("claude-haiku-3-5-20241022");
  });

  test("GET / serves index.html", async () => {
    const res = await fetch(`${BASE_URL}/`);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(text).toContain("<!DOCTYPE html>");
  });

  test("GET /styles.css serves CSS", async () => {
    const res = await fetch(`${BASE_URL}/styles.css`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css");
  });

  test("POST /api/chat streams response", async () => {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-3-5-20241022",
        system: "You are a helpful assistant. Respond with exactly: OK",
        messages: [{ role: "user", content: "Test" }],
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
});
