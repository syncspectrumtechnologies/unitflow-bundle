const prisma = require('../config/db');
const httpError = require('../utils/httpError');
const { createAudit } = require('../services/auditService');
const { upsertRuntimeDevice, createRuntimeSession } = require('../services/runtimeAccessService');

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
    if (!tenant.runtime_owner_user_id) {
      throw httpError(409, 'Runtime owner user is not provisioned yet for this tenant');
    }

    const { device, latestSubscription } = await upsertRuntimeDevice({
      tenant,
      accountId: req.account.id,
      deviceFingerprint: device_fingerprint,
      deviceName: device_name,
      platform,
      osVersion: os_version,
      appVersion: app_version,
      forceTakeover: force_takeover
    });

    const { token, session, plan, role } = await createRuntimeSession({
      tenant,
      accountId: req.account.id,
      deviceId: device.id,
      runtimeUser: {
        id: tenant.runtime_owner_user_id,
        is_admin: true,
        roles: ['ADMIN'],
        role: 'ADMIN'
      }
    });

    await createAudit({ actorType: 'ACCOUNT', actorId: req.account.id, tenantId: tenant_id, entityType: 'device', entityId: device.id, action: 'runtime.device.registered', metadata: { force_takeover, plan, role } });

    res.status(201).json({ ok: true, device, runtime_session: { id: session.id, expires_at: session.expires_at }, token, plan });
  } catch (error) {
    next(error);
  }
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
