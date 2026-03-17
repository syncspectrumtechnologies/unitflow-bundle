const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const prisma = require("./config/db");
const { env, isOriginAllowed } = require("./config/env");
const requestContextMiddleware = require("./middlewares/requestContextMiddleware");
const requestTimingMiddleware = require("./middlewares/requestTimingMiddleware");
const compressionMiddleware = require("./middlewares/compressionMiddleware");
const activityMiddleware = require("./middlewares/activityMiddleware");
const baselineValidationMiddleware = require("./middlewares/baselineValidationMiddleware");
const notFoundHandler = require("./middlewares/notFoundHandler");
const errorHandler = require("./middlewares/errorHandler");

const adminRoutes = require("./routes/adminRoutes");
const authRoutes = require("./routes/authRoutes");
const factoryRoutes = require("./routes/factoryRoutes");
const clientRoutes = require("./routes/clientRoutes");
const clientContactRoutes = require("./routes/clientContactRoutes");
const clientProductRoutes = require("./routes/clientProductRoutes");
const categoryRoutes = require("./routes/categoryRoutes");
const productRoutes = require("./routes/productRoutes");
const productionRoutes = require("./routes/productionRoutes");
const inventoryItemRoutes = require("./routes/inventoryItemRoutes");
const inventoryMovementRoutes = require("./routes/inventoryMovementRoutes");
const orderRoutes = require("./routes/orderRoutes");
const invoiceRoutes = require("./routes/invoiceRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const purchaseRoutes = require("./routes/purchaseRoutes");
const permissionViewRoutes = require("./routes/permissionViewRoutes");
const messageRoutes = require("./routes/messageRoutes");
const statsRoutes = require("./routes/statsRoutes");
const salesCompanyRoutes = require("./routes/salesCompanyRoutes");
const chatRoutes = require("./routes/chatRoutes");
const broadcastRoutes = require("./routes/broadcastRoutes");
const internalPlatformRoutes = require("./routes/internalPlatformRoutes");

const app = express();

function buildRateLimitOptions(baseOptions) {
  const opts = { ...baseOptions };
  if (String(process.env.REDIS_RATE_LIMIT_ENABLED || "false").toLowerCase() !== "true") {
    return opts;
  }

  try {
    const { RedisStore } = require("rate-limit-redis");
    const { createClient } = require("redis");
    const client = createClient({ url: process.env.REDIS_URL });
    client.connect().catch((err) => console.error("Redis rate-limit connect error:", err?.message || err));
    opts.store = new RedisStore({
      sendCommand: (...args) => client.sendCommand(args)
    });
  } catch (err) {
    console.warn("Redis-backed rate limiting not enabled; using in-memory store.");
  }

  return opts;
}

app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY || 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  referrerPolicy: { policy: "no-referrer" }
}));

app.use(cors({
  origin(origin, callback) {
    if (isOriginAllowed(origin)) return callback(null, true);
    const err = new Error("Origin not allowed by CORS policy");
    err.statusCode = 403;
    return callback(err);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "X-Factory-Id", "X-Request-Id", "Idempotency-Key", "X-Idempotency-Key"],
  exposedHeaders: ["X-Request-Id", "Idempotency-Status"]
}));

app.use(requestContextMiddleware);
app.use(requestTimingMiddleware);
app.use(compressionMiddleware);
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "5mb" }));
app.use(express.urlencoded({ extended: false, limit: process.env.JSON_BODY_LIMIT || "5mb" }));
app.use(baselineValidationMiddleware);
app.use(activityMiddleware);

app.use(
  rateLimit(buildRateLimitOptions({
    windowMs: 60 * 1000,
    max: env.rateLimitMaxPerMin,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === "/health" || req.path === "/ready"
  }))
);

const authLimiter = rateLimit(buildRateLimitOptions({
  windowMs: 15 * 60 * 1000,
  max: env.authRateLimitMaxPer15Min,
  standardHeaders: true,
  legacyHeaders: false
}));

app.get("/health", (req, res) => {
  return res.json({
    ok: true,
    service: env.serviceName,
    app: env.appName,
    runtime_mode: env.runtimeMode,
    api_client_mode: env.apiClientMode,
    request_id: req.request_id,
    uptime_sec: Math.round(process.uptime())
  });
});

app.get("/ready", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.json({
      ok: true,
      service: env.serviceName,
      db: "ready",
      build_fingerprint: env.buildFingerprint,
      request_id: req.request_id
    });
  } catch (err) {
    return res.status(503).json({
      ok: false,
      service: env.serviceName,
      db: "not_ready",
      request_id: req.request_id
    });
  }
});

app.use("/auth", authLimiter, authRoutes);
app.use("/admin", adminRoutes);
app.use("/factories", factoryRoutes);
app.use("/clients", clientRoutes);
app.use("/clients", clientContactRoutes);
app.use("/clients", clientProductRoutes);
app.use("/categories", categoryRoutes);
app.use("/products", productRoutes);
app.use("/production", productionRoutes);
app.use("/inventory/items", inventoryItemRoutes);
app.use("/inventory", inventoryMovementRoutes);
app.use("/orders", orderRoutes);
app.use("/invoices", invoiceRoutes);
app.use("/payments", paymentRoutes);
app.use("/sales-companies", salesCompanyRoutes);
app.use("/purchases", purchaseRoutes);
app.use("/permissions", permissionViewRoutes);
app.use("/messages", messageRoutes);
app.use("/chat", chatRoutes);
app.use("/broadcast", broadcastRoutes);
app.use("/stats", statsRoutes);
app.use("/internal/platform", internalPlatformRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
