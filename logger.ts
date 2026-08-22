type LogLevel = "debug" | "info" | "warn" | "error";
type ConfiguredLogLevel = LogLevel | "silent";
type LogContext = Record<string, unknown>;

export type { ConfiguredLogLevel, LogContext, LogLevel };

const LOG_LEVELS: Record<ConfiguredLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};

// ── ANSI palette ────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const COLOR = {
  gray: (s: string) => `\x1b[90m${s}${RESET}`,
  cyan: (s: string) => `\x1b[36m${s}${RESET}`,
  green: (s: string) => `\x1b[32m${s}${RESET}`,
  yellow: (s: string) => `\x1b[33m${s}${RESET}`,
  red: (s: string) => `\x1b[31m${s}${RESET}`,
  magenta: (s: string) => `\x1b[35m${s}${RESET}`,
  blue: (s: string) => `\x1b[34m${s}${RESET}`,
} as const;

const LEVEL_BADGES: Record<LogLevel, string> = {
  debug: "debug",
  info: "info ",
  warn: "warn ",
  error: "error",
};

const LEVEL_COLOR: Record<LogLevel, (s: string) => string> = {
  debug: COLOR.gray,
  info: COLOR.green,
  warn: COLOR.yellow,
  error: COLOR.red,
};

function parseLogLevel(value: string | undefined): ConfiguredLogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error" || value === "silent") {
    return value;
  }
  return "info";
}

function parseEnabled(value: string | undefined, defaultValue: boolean): boolean {
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

const LOG_LEVEL = parseLogLevel(process.env.LOG_LEVEL);

/** Evaluated per call so tests and runtime can toggle formatting via env. */
function jsonLogsEnabled(): boolean {
  return parseEnabled(process.env.LOG_FORMAT_JSON, false)
    || parseEnabled(process.env.LOG_JSON, false);
}

/** Force-disable color even on a TTY (respects the NO_COLOR convention). */
function colorEnabled(): boolean {
  if (jsonLogsEnabled()) return false;
  return parseEnabled(process.env.LOG_COLOR, true)
    && !parseEnabled(process.env.NO_COLOR, false)
    && Boolean(process.stdout?.isTTY);
}

export function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[LOG_LEVEL];
}

function cleanContext(context: LogContext): LogContext {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  );
}

function shortTime(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function formatScalar(value: unknown): string {
  if (typeof value === "string") {
    const oneLine = value.replace(/\s+/g, " ").trim();
    return oneLine.length > 96 ? `${oneLine.slice(0, 93)}…` : oneLine || '""';
  }
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return String(value);
  if (value === null) return "null";
  try {
    const json = JSON.stringify(value);
    if (!json) return String(value);
    const oneLine = json.replace(/\s+/g, " ").trim();
    return oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine;
  } catch {
    return String(value);
  }
}

/** Render one log record as a colored, aligned terminal line. */
export function formatColoredLog(
  level: LogLevel,
  event: string,
  context: LogContext,
  timestamp: Date,
  options?: { color?: boolean },
): string {
  const color = options?.color ?? colorEnabled();
  const badgeText = LEVEL_BADGES[level];
  const badge = LEVEL_COLOR[level](color ? badgeText : badgeText.trim());
  const time = color ? COLOR.gray(shortTime(timestamp)) : shortTime(timestamp);
  const name = color ? `${BOLD}${event}${RESET}` : event;

  const parts = [time, badge, name];

  for (const [key, rawValue] of Object.entries(cleanContext(context))) {
    let keyText = key;
    let valueText = formatScalar(rawValue);
    if (color) {
      keyText = COLOR.gray(keyText);
      if (level === "error" && key === "error") valueText = COLOR.red(valueText);
      else if (typeof rawValue === "number") valueText = COLOR.cyan(valueText);
      else if (rawValue === true) valueText = COLOR.magenta(valueText);
      else if (rawValue === false) valueText = COLOR.gray(valueText);
    }
    parts.push(`${keyText}${color ? COLOR.gray("=") : "="}${valueText}`);
  }

  return parts.join(color ? ` ${COLOR.gray("·")} ` : " ");
}

interface LogSink {
  stdout(line: string): void;
  stderr(line: string): void;
}

const defaultSink: LogSink = {
  stdout(line: string) {
    console.log(line);
  },
  stderr(line: string) {
    console.error(line);
  },
};

let sink: LogSink = defaultSink;

/** Test seam: redirect console output. Pass null to restore. */
export function setLogSink(next: LogSink | null): void {
  sink = next ?? defaultSink;
}

function writeLog(level: LogLevel, event: string, context: LogContext = {}): void {
  if (!shouldLog(level)) return;

  const now = new Date();

  if (jsonLogsEnabled()) {
    const record = {
      timestamp: now.toISOString(),
      level,
      event,
      ...cleanContext(context),
    };
    const line = JSON.stringify(record);
    if (level === "warn" || level === "error") sink.stderr(line);
    else sink.stdout(line);
    return;
  }

  const line = formatColoredLog(level, event, context, now);
  if (level === "warn" || level === "error") sink.stderr(line);
  else sink.stdout(line);
}

export const logger = {
  debug: (event: string, context?: LogContext) => writeLog("debug", event, context),
  info: (event: string, context?: LogContext) => writeLog("info", event, context),
  warn: (event: string, context?: LogContext) => writeLog("warn", event, context),
  error: (event: string, context?: LogContext) => writeLog("error", event, context),
};
