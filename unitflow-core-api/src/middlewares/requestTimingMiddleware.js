const { env } = require("../config/env");
const logger = require("../utils/logger");

module.exports = function requestTimingMiddleware(req, res, next) {
  const startNs = process.hrtime.bigint();
  const startedAt = Date.now();

  res.on("finish", () => {
    const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
    if (env.requestLogAll || elapsedMs >= env.slowRequestMs) {
      logger.info("HTTP request completed", {
        request_id: req.request_id,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        duration_ms: Number(elapsedMs.toFixed(1)),
        ip: req.ip,
        user_id: req.user?.id || null,
        company_id: req.user?.company_id || null
      });
    }
  });

  req._request_started_at = startedAt;
  next();
};
