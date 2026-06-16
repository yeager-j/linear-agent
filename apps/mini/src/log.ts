// Tiny structured logger. JSON lines so launchd/console capture is greppable.

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + "\n");
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => {
    if (process.env.LOG_LEVEL === "debug") emit("debug", msg, fields);
  },
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
