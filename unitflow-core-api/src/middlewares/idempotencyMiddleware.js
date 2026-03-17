const { env } = require("../config/env");
const store = require("../services/idempotencyStore");

module.exports = function idempotencyMiddleware(options = {}) {
  const ttlSec = options.ttlSec || env.idempotencyTtlSec;

  return (req, res, next) => {
    if (!env.idempotencyEnabled) return next();

    const requestKey = req.headers["idempotency-key"] || req.headers["x-idempotency-key"];
    if (!requestKey) return next();

    const key = store.buildKey({
      requestKey: String(requestKey),
      userId: req.user?.id,
      method: req.method,
      path: req.originalUrl.split("?")[0]
    });

    const hit = store.get(key);
    if (hit?.state === "done") {
      res.setHeader("Idempotency-Status", "cached");
      if (hit.headers?.["content-type"]) {
        res.setHeader("Content-Type", hit.headers["content-type"]);
      }
      return res.status(hit.statusCode).send(hit.body);
    }

    if (hit?.state === "in_progress") {
      return res.status(409).json({ message: "A request with this idempotency key is already in progress" });
    }

    store.set(key, { state: "in_progress" }, ttlSec);

    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    function saveAndReturn(body, sender) {
      store.set(
        key,
        {
          state: "done",
          statusCode: res.statusCode,
          body,
          headers: {
            "content-type": res.getHeader("content-type")
          }
        },
        ttlSec
      );
      res.setHeader("Idempotency-Status", "stored");
      return sender(body);
    }

    res.json = (body) => saveAndReturn(body, originalJson);
    res.send = (body) => saveAndReturn(body, originalSend);
    return next();
  };
};
