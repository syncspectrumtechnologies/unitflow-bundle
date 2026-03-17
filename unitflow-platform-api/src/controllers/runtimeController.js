const prisma = require('../config/db');
const httpError = require('../utils/httpError');
const { hashDeviceFingerprint, signRuntimeToken } = require('../utils/security');
const { env } = require('../config/env');
const { createAudit } = require('../services/auditService');

async function getOwnedTenant(accountId, tenantId) {
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, owner_account_id: accountId },
    include: { subscriptions: { include: { plan: true }, orderBy: { created_at: 'desc' }, take: 1 }, devices: true }
  });
  if (!tenant) throw httpError(404, 'Tenant not found');
  return tenant;
}

exports.registerDevice = async (req, res, next) => {
  try {
    const { tenant_id, device_fingerprint, device_name, platform, os_version, app_version, force_takeover = false } = req.body || {};
    if (!tenant_id || !device_fingerprint) throw httpError(400, 'tenant_id and device_fingerprint are required');

    const tenant = await getOwnedTenant(req.account.id, tenant_id);
    if (!['TRIAL_ACTIVE', 'ACTIVE', 'GRACE'].includes(tenant.lifecycle_status)) {
      throw httpError(403, 'Tenant is not active for runtime access');
    }

    const latestSubscription = tenant.subscriptions[0];
    if (!latestSubscription) throw httpError(403, 'No active subscription found');

    const fingerprintHash = hashDeviceFingerprint(device_fingerprint);
    const activeOtherDevices = tenant.devices.filter((d) => d.is_active && d.device_fingerprint_hash !== fingerprintHash && !d.revoked_at);

    if (latestSubscription.plan.plan_type === 'SINGLE_USER' && activeOtherDevices.length > 0 && !force_takeover) {
      return res.status(409).json({
        ok: false,
        code: 'ACTIVE_DEVICE_CONFLICT',
        message: 'Another device is already active for this single-user workspace',
        active_devices: activeOtherDevices.map((d) => ({ id: d.id, device_name: d.device_name, platform: d.platform, last_seen_at: d.last_seen_at }))
      });
    }

    if (force_takeover && activeOtherDevices.length > 0) {
      const ids = activeOtherDevices.map((d) => d.id);
      await prisma.device.updateMany({ where: { id: { in: ids } }, data: { is_active: false, revoked_at: new Date() } });
      await prisma.runtimeSession.updateMany({ where: { tenant_id, device_id: { in: ids }, revoked_at: null }, data: { revoked_at: new Date(), revoke_reason: 'device_takeover' } });
    }

    let device = await prisma.device.findFirst({ where: { tenant_id, account_id: req.account.id, device_fingerprint_hash: fingerprintHash } });
    if (device) {
      device = await prisma.device.update({
        where: { id: device.id },
        data: {
          device_name: device_name || device.device_name,
          platform: platform || device.platform,
          os_version: os_version || device.os_version,
          app_version: app_version || device.app_version,
          is_active: true,
          revoked_at: null,
          last_seen_at: new Date()
        }
      });
    } else {
      device = await prisma.device.create({
        data: {
          tenant_id,
          account_id: req.account.id,
          device_fingerprint_hash: fingerprintHash,
          device_name: device_name || null,
          platform: platform || null,
          os_version: os_version || null,
          app_version: app_version || null,
          is_active: true
        }
      });
    }

    const { token, jti } = signRuntimeToken({ account_id: req.account.id, tenant_id, device_id: device.id }, env.jwtExpiresIn);
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
    const session = await prisma.runtimeSession.create({
      data: {
        tenant_id,
        account_id: req.account.id,
        device_id: device.id,
        jti,
        scope: 'RUNTIME',
        expires_at: expiresAt
      }
    });

    await createAudit({ actorType: 'ACCOUNT', actorId: req.account.id, tenantId: tenant_id, entityType: 'device', entityId: device.id, action: 'runtime.device.registered', metadata: { force_takeover } });

    res.status(201).json({ ok: true, device, runtime_session: { id: session.id, expires_at: session.expires_at }, token });
  } catch (error) { next(error); }
};

exports.listDevices = async (req, res, next) => {
  try {
    const tenant = await getOwnedTenant(req.account.id, req.params.tenantId);
    res.json({ ok: true, devices: tenant.devices });
  } catch (error) { next(error); }
};

exports.revokeDevice = async (req, res, next) => {
  try {
    const tenant = await getOwnedTenant(req.account.id, req.params.tenantId);
    const device = tenant.devices.find((d) => d.id === req.params.deviceId);
    if (!device) throw httpError(404, 'Device not found');
    await prisma.device.update({ where: { id: device.id }, data: { is_active: false, revoked_at: new Date() } });
    await prisma.runtimeSession.updateMany({ where: { device_id: device.id, revoked_at: null }, data: { revoked_at: new Date(), revoke_reason: 'manual_revoke' } });
    await createAudit({ actorType: 'ACCOUNT', actorId: req.account.id, tenantId: tenant.id, entityType: 'device', entityId: device.id, action: 'runtime.device.revoked' });
    res.json({ ok: true });
  } catch (error) { next(error); }
};
