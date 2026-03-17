const prisma = require("../config/db");
const { env } = require("../config/env");
const logger = require("../utils/logger");

module.exports = async (req, res, next) => {
  const start = Date.now();

  res.on("finish", async () => {
    try {
      if (!env.activityLogEnabled) return;
      if (!req.user || req.method === "GET" || res.statusCode >= 400) return;

      await prisma.activityLog.create({
        data: {
          company_id: req.user.company_id,
          factory_id: req.factory_id || null,
          user_id: req.user.id,
          action: `${req.method} ${req.originalUrl}`,
          entity_type: "http_request",
          entity_id: null,
          meta: {
            duration_ms: Date.now() - start,
            status: res.statusCode,
            request_id: req.request_id
          },
          ip: req.ip,
          user_agent: req.headers["user-agent"]
        }
      });
    } catch (err) {
      logger.warn("Activity log failed", {
        request_id: req.request_id,
        error_message: err?.message || String(err)
      });
    }
  });

  next();
};
