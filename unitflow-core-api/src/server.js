require("dotenv").config();
require("./utils/consolePatch");
const app = require("./app");
const prisma = require("./config/db");
const { env, validate } = require("./config/env");
const logger = require("./utils/logger");
const { ensureDefaultPermissions, ensureSystemRoles } = require("./utils/permissionSeeder");
const { initSocketServer } = require("./sockets/socketServer");
const { startMessageDispatchQueue } = require("./services/messageDispatchQueue");

if (env.validateEnvOnBoot) {
  validate();
}

(async () => {
  try {
    await ensureDefaultPermissions();
    await ensureSystemRoles();
  } catch (e) {
    logger.error("Permission seeding failed", { error_message: e?.message || String(e) });
  }

  const { server } = initSocketServer(app);
  startMessageDispatchQueue();

  const gracefulShutdown = async (signal) => {
    logger.info("Received shutdown signal", { signal });
    server.close(async () => {
      await prisma.$disconnect().catch(() => null);
      process.exit(0);
    });
  };

  process.on("SIGTERM", gracefulShutdown);
  process.on("SIGINT", gracefulShutdown);

  server.listen(env.port, "0.0.0.0", () => {
    logger.info("UnitFlow core API started", {
      port: env.port,
      runtime_mode: env.runtimeMode,
      api_client_mode: env.apiClientMode,
      build_fingerprint: env.buildFingerprint
    });
  });
})();
