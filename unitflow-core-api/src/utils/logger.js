const { env } = require("../config/env");

const levels = ["debug", "info", "warn", "error"];

function shouldLog(level) {
  return levels.indexOf(level) >= levels.indexOf(env.logLevel);
}

function safeSerialize(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function write(level, message, meta = {}) {
  if (!shouldLog(level)) return;
  const payload = {
    ts: new Date().toISOString(),
    level,
    service: env.serviceName,
    message,
    ...safeSerialize(meta)
  };
  const line = JSON.stringify(payload);
  if (level === "error") return process.stderr.write(line + "\n");
  return process.stdout.write(line + "\n");
}

module.exports = {
  debug: (message, meta) => write("debug", message, meta),
  info: (message, meta) => write("info", message, meta),
  warn: (message, meta) => write("warn", message, meta),
  error: (message, meta) => write("error", message, meta)
};
