const crypto = require("crypto");
const { env } = require("../config/env");

module.exports = function requestContextMiddleware(req, res, next) {
  const headerName = env.requestIdHeader;
  const incoming = req.headers[headerName];
  const requestId = incoming ? String(incoming) : crypto.randomUUID();
  req.request_id = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
};
