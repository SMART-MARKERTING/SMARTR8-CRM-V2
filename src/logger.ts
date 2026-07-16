type Level = "info" | "warn" | "error";

const SENSITIVE_KEY = /(?:pass|password|token|secret|authorization|api[_-]?key|signature|payload|raw|body|message|text|phone|email|endpoint|url|recipient|err(?:or)?|detail|response|\bto\b|\bfrom\b)/i;

function scrubText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
    .replace(/([?&](?:key|token|secret|password|signature|api[_-]?key)=)[^&#\s]+/gi, "$1***")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\+\d{10,15}\b/g, "[redacted-phone]");
}

function redact(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value, (key, val) => {
        if (key && SENSITIVE_KEY.test(key)) return "***";
        return typeof val === "string" ? scrubText(val) : val;
      }),
    );
  } catch {
    return "[unserializable redacted value]";
  }
}

function emit(level: Level, msg: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} [${level}] ${scrubText(msg)}`;
  const sink = level === "info" ? console.log : level === "warn" ? console.warn : console.error;
  if (extra === undefined) sink(line);
  else sink(line, redact(extra));
}

export const log = {
  info: (m: string, e?: unknown) => emit("info", m, e),
  warn: (m: string, e?: unknown) => emit("warn", m, e),
  error: (m: string, e?: unknown) => emit("error", m, e),
};
