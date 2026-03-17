const logger = require("../utils/logger");

module.exports = function errorHandler(err, req, res, next) {
  const status = Number(err?.statusCode || err?.status || 500);
  logger.error("Unhandled request error", {
    request_id: req.request_id,
    method: req.method,
    url: req.originalUrl,
    status,
    error_name: err?.name,
    error_message: err?.message,
    stack: process.env.NODE_ENV === "production" ? undefined : err?.stack
  });

  if (res.headersSent) return next(err);

  return res.status(status).json({
    message: status >= 500 ? "Internal server error" : (err?.message || "Request failed"),
    request_id: req.request_id
  });
};
