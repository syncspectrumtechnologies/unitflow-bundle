const crypto = require("crypto");
const { env } = require("../config/env");

const store = new Map();

function cleanup() {
  const now = Date.now();
  for (const [key, value] of store.entries()) {
    if (value.expires_at <= now) store.delete(key);
  }
}

function buildKey({ requestKey, userId, method, path }) {
  const raw = `${userId || "anon"}:${method}:${path}:${requestKey}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function get(recordKey) {
  cleanup();
  const value = store.get(recordKey);
  return value && value.expires_at > Date.now() ? value : null;
}

function set(recordKey, payload, ttlSec = env.idempotencyTtlSec) {
  store.set(recordKey, {
    ...payload,
    expires_at: Date.now() + ttlSec * 1000
  });
}

module.exports = {
  buildKey,
  get,
  set
};
