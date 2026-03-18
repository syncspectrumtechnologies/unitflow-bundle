const prisma = require('../config/db');
const httpError = require('../utils/httpError');
const { env } = require('../config/env');
const { signRuntimeToken, hashDeviceFingerprint } = require('../utils/security');

function expiresInToMs(value) {
  const v = String(value || '12h').trim();
  const m = v.match(/^(\d+)([smhd])?$/i);
  if (!m) return 12 * 60 * 60 * 1000;
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * mult;
}

function getLatestSubscription(tenant) {
  return Array.isArray(tenant.subscriptions) ? tenant.subscriptions[0] || null : null;
}

function assertRuntimeEligible(tenant) {
  if (!tenant) throw httpError(404, 'Tenant not found');
  if (!['ACTIVE', 'GRACE'].includes(tenant.lifecycle_status)) {
    throw httpError(403, 'Tenant is not active for runtime access');
  }

  const latestSubscription = getLatestSubscription(tenant);
  if (!latestSubscription) throw httpError(403, 'No active subscription found');
  if (!['ACTIVE', 'GRACE'].includes(latestSubscription.status)) {
    throw httpError(403, 'Subscription is not active for runtime access');
  }

  return latestSubscription;
}

async function upsertRuntimeDevice({ tenant, accountId, deviceFingerprint, deviceName, platform, osVersion, appVersion, forceTakeover = false }) {
  if (!deviceFingerprint) throw httpError(400, 'device_fingerprint is required');

  const latestSubscription = assertRuntimeEligible(tenant);
  const fingerprintHash = hashDeviceFingerprint(deviceFingerprint);
  const activeOtherDevices = tenant.devices.filter((d) => d.is_active && d.device_fingerprint_hash !== fingerprintHash && !d.revoked_at);

  if (latestSubscription.plan.plan_type === 'SINGLE_USER' && activeOtherDevices.length > 0 && !forceTakeover) {
    throw httpError(409, 'Another device is already active for this single-user workspace', {
      code: 'ACTIVE_DEVICE_CONFLICT',
      active_devices: activeOtherDevices.map((d) => ({ id: d.id, device_name: d.device_name, platform: d.platform, last_seen_at: d.last_seen_at }))
    });
  }

  if (forceTakeover && activeOtherDevices.length > 0) {
    const ids = activeOtherDevices.map((d) => d.id);
    await prisma.device.updateMany({ where: { id: { in: ids } }, data: { is_active: false, revoked_at: new Date() } });
    await prisma.runtimeSession.updateMany({ where: { tenant_id: tenant.id, device_id: { in: ids }, revoked_at: null }, data: { revoked_at: new Date(), revoke_reason: 'device_takeover' } });
  }

  let device = await prisma.device.findFirst({ where: { tenant_id: tenant.id, device_fingerprint_hash: fingerprintHash } });
  if (device) {
    device = await prisma.device.update({
      where: { id: device.id },
      data: {
        account_id: accountId,
        device_name: deviceName || device.device_name,
        platform: platform || device.platform,
        os_version: osVersion || device.os_version,
        app_version: appVersion || device.app_version,
        is_active: true,
        revoked_at: null,
        last_seen_at: new Date()
      }
    });
  } else {
    device = await prisma.device.create({
      data: {
        tenant_id: tenant.id,
        account_id: accountId,
        device_fingerprint_hash: fingerprintHash,
        device_name: deviceName || null,
        platform: platform || null,
        os_version: osVersion || null,
        app_version: appVersion || null,
        is_active: true
      }
    });
  }

  return { device, latestSubscription };
}

async function createRuntimeSession({ tenant, accountId, deviceId, runtimeUser }) {
  const latestSubscription = assertRuntimeEligible(tenant);
  const role = runtimeUser.role || (runtimeUser.is_admin ? 'ADMIN' : (Array.isArray(runtimeUser.roles) ? runtimeUser.roles[0] : 'STAFF')) || 'STAFF';
  const plan = latestSubscription.plan?.code || latestSubscription.plan_snapshot_json?.code || latestSubscription.plan?.plan_type || null;
  const companyId = tenant.runtime_company_id || tenant.id;

  const { token, jti } = signRuntimeToken({
    user_id: runtimeUser.id,
    tenant_id: tenant.id,
    company_id: companyId,
    account_id: accountId,
    plan,
    role,
    roles: Array.isArray(runtimeUser.roles) ? runtimeUser.roles : [],
    device_id: deviceId
  }, env.runtimeJwtExpiresIn);

  const expiresAt = new Date(Date.now() + expiresInToMs(env.runtimeJwtExpiresIn));
  const session = await prisma.runtimeSession.create({
    data: {
      tenant_id: tenant.id,
      account_id: accountId,
      device_id: deviceId,
      jti,
      scope: 'RUNTIME',
      expires_at: expiresAt
    }
  });

  return { token, session, plan, role };
}

module.exports = {
  assertRuntimeEligible,
  upsertRuntimeDevice,
  createRuntimeSession
};
