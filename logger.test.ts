import { describe, expect, test } from "bun:test";

process.env.NO_COLOR = "1";

const { formatColoredLog, shouldLog, setLogSink } = await import("./logger");

describe("colored log formatting", () => {
  const timestamp = new Date(2026, 7, 22, 13, 45, 12, 340);

  test("renders time, level badge, event, and context pairs", () => {
    const line = formatColoredLog(
      "info",
      "chat.stream.start",
      { request_id: "r-1", model: "z-ai/glm-5.3", messages: 3 },
      timestamp,
    );
    expect(line).toContain("13:45:12.340");
    expect(line).toContain("info");
    expect(line).toContain("chat.stream.start");
    expect(line).toContain("request_id=r-1");
    expect(line).toContain("model=z-ai/glm-5.3");
    expect(line).toContain("messages=3");
  });

  test("collapses whitespace and truncates long string values", () => {
    const longDetails = `${"y".repeat(300)}\nwith   gaps\tand a tab`;
    const line = formatColoredLog(
      "warn",
      "chat.upstream.rejected",
      { details: longDetails },
      timestamp,
    );
    expect(line.includes("\n")).toBe(false);
    expect(line.length).toBeLessThan(200);
    expect(line).toContain("…");
  });

  test("omits undefined values and renders nested objects as compact JSON", () => {
    const line = formatColoredLog(
      "error",
      "request.unhandled_error",
      { error: undefined, details: { name: "TypeError", message: "boom" } },
      timestamp,
    );
    expect(line).not.toContain("error=undefined");
    expect(line).toContain("details=");
    expect(line).toContain("TypeError");
  });

  test("shouldLog respects the configured level ordering", () => {
    expect(shouldLog("error")).toBe(true);
    expect(shouldLog("debug")).toBe(process.env.LOG_LEVEL === "debug");
  });

  test("setLogSink routes warn/error to stderr in JSON mode", async () => {
    const savedNoColor = process.env.NO_COLOR;
    process.env.LOG_FORMAT_JSON = "1";
    const jsonLogger = await import("./logger");

    const out: Array<{ stream: string; line: string }> = [];
    setLogSink({
      stdout: (line) => out.push({ stream: "stdout", line }),
      stderr: (line) => out.push({ stream: "stderr", line }),
    });
    try {
      jsonLogger.logger.info("sink.test.info", { a: 1 });
      jsonLogger.logger.error("sink.test.error", { b: 2 });

      expect(out).toHaveLength(2);
      expect(out[0].stream).toBe("stdout");
      expect(out[1].stream).toBe("stderr");

      const first = JSON.parse(out[0].line) as Record<string, unknown>;
      expect(first.event).toBe("sink.test.info");
      expect(first.level).toBe("info");
      expect(first.a).toBe(1);

      const second = JSON.parse(out[1].line) as Record<string, unknown>;
      expect(second.event).toBe("sink.test.error");
    } finally {
      setLogSink(null);
      delete process.env.LOG_FORMAT_JSON;
      if (savedNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = savedNoColor;
    }
  });
});
