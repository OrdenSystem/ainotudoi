type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const current: Level = (process.env.LOG_LEVEL as Level) ?? "info";

function emit(level: Level, msg: string, extra?: unknown) {
  if (ORDER[level] < ORDER[current]) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  const line = extra === undefined ? `${prefix} ${msg}` : `${prefix} ${msg} ${JSON.stringify(extra)}`;
  process.stderr.write(line + "\n");
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit("debug", msg, extra),
  info: (msg: string, extra?: unknown) => emit("info", msg, extra),
  warn: (msg: string, extra?: unknown) => emit("warn", msg, extra),
  error: (msg: string, extra?: unknown) => emit("error", msg, extra),
};
