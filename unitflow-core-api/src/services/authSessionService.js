const jwt = require("jsonwebtoken");
const prisma = require("../config/db");
const { env } = require("../config/env");

const roleCache = new Map();

function getRoleCacheKey(company_id, user_id) {
  return `${company_id}:${user_id}`;
}

async function getUserRoles(company_id, user) {
  const ttlMs = Number(process.env.ROLE_CACHE_TTL_MS || 30_000);
  const cacheKey = getRoleCacheKey(company_id, user.id);
  const cached = roleCache.get(cacheKey);
  if (cached && cached.expires_at > Date.now()) {
    return cached.roles;
  }

  const roleRows = await prisma.userRoleMap.findMany({
    where: { company_id, user_id: user.id },
    include: { role: { select: { name: true, is_active: true } } }
  });

  let roles = roleRows
    .filter((row) => row.role?.is_active)
    .map((row) => row.role?.name)
    .filter(Boolean);

  if (!user.is_admin && roles.length === 0) roles = ["STAFF"];

  roleCache.set(cacheKey, { roles, expires_at: Date.now() + ttlMs });
  return roles;
}

async function touchSessionIfNeeded(session) {
  if (!session) return;
  const intervalMs = Number(process.env.SESSION_TOUCH_INTERVAL_MS || 60_000);
  const cutoff = new Date(Date.now() - intervalMs);
  if (session.last_seen_at && new Date(session.last_seen_at) >= cutoff) return;

  await prisma.userSession.updateMany({
    where: { id: session.id, last_seen_at: { lt: cutoff } },
    data: { last_seen_at: new Date() }
  });
}

async function loadActiveUser(decoded) {
  const companyId = decoded.company_id || decoded.tenant_id;
  if (!decoded.user_id || !companyId) return null;

  const user = await prisma.user.findFirst({
    where: {
      id: decoded.user_id,
      company_id: companyId,
      status: "ACTIVE",
      company: { is: { is_active: true } }
    },
    select: {
      id: true,
      company_id: true,
      is_admin: true,
      email: true,
      name: true,
      status: true
    }
  });

  if (!user) return null;
  const roles = await getUserRoles(user.company_id, user);

  return {
    id: user.id,
    company_id: user.company_id,
    is_admin: user.is_admin,
    email: user.email,
    name: user.name,
    roles,
    role: decoded.role || (user.is_admin ? "ADMIN" : roles[0] || "STAFF"),
    jti: decoded.jti || null,
    device_id: decoded.device_id || null,
    account_id: decoded.account_id || null,
    plan: decoded.plan || null,
    token_source: decoded.token_type === "runtime" ? "platform" : "core"
  };
}

function verifyPlatformRuntimeToken(token) {
  const verifyOptions = {};
  if (env.platformRuntimeJwtIssuer) verifyOptions.issuer = env.platformRuntimeJwtIssuer;
  if (env.platformRuntimeJwtAudience) verifyOptions.audience = env.platformRuntimeJwtAudience;
  return jwt.verify(token, env.platformRuntimeJwtSecret, verifyOptions);
}

async function authenticateCoreToken(token, { touchSession = true } = {}) {
  if (!env.allowDirectCoreLogin) return null;

  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const user = await loadActiveUser(decoded);
  if (!user) return null;

  let session = null;
  if (decoded.jti) {
    session = await prisma.userSession.findFirst({
      where: {
        company_id: user.company_id,
        user_id: user.id,
        token_jti: decoded.jti,
        revoked_at: null,
        expires_at: { gt: new Date() }
      },
      select: { id: true, last_seen_at: true }
    });

    if (!session) return null;
    if (touchSession) await touchSessionIfNeeded(session);
  }

  return user;
}

async function authenticatePlatformRuntimeToken(token) {
  const decoded = verifyPlatformRuntimeToken(token);
  if (decoded.token_type !== "runtime") return null;
  return loadActiveUser(decoded);
}

async function authenticateToken(token, { touchSession = true } = {}) {
  const decoded = jwt.decode(token) || {};

  if (decoded.token_type === "runtime") {
    try {
      return await authenticatePlatformRuntimeToken(token);
    } catch (error) {
      return null;
    }
  }

  try {
    return await authenticateCoreToken(token, { touchSession });
  } catch (error) {
    return null;
  }
}

module.exports = {
  authenticateToken,
  getUserRoles,
  verifyPlatformRuntimeToken
};
