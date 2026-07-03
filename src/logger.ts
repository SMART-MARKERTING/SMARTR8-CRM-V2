type Level = "info" | "warn" | "error";

function redact(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value, (key, val) =>
        /pass|token|secret|authorization|api[_-]?key/i.test(key) ? "***" : val,
      ),
    );
  } catch {
    return value;
  }
}

function emit(level: Level, msg: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  const sink = level === "info" ? console.log : level === "warn" ? console.warn : console.error;
  if (extra === undefined) sink(line);
  else sink(line, redact(extra));
}

export const log = {
  info: (m: string, e?: unknown) => emit("info", m, e),
  warn: (m: string, e?: unknown) => emit("warn", m, e),
  error: (m: string, e?: unknown) => emit("error", m, e),
};
