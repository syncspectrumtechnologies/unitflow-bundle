const bcrypt = require('bcrypt');
const prisma = require('../config/db');
const { env } = require('../config/env');
const httpError = require('../utils/httpError');
const { signAccountToken } = require('../utils/security');
const { createVerification, verifyCode } = require('../services/verificationService');
const { createAudit } = require('../services/auditService');
const { authenticateRuntimeUser } = require('../services/coreSyncService');
const { upsertRuntimeDevice, createRuntimeSession } = require('../services/runtimeAccessService');

exports.signup = async (req, res, next) => {
  try {
    const { email, phone, name, password } = req.body || {};
    if (!email || !phone || !name || !password) throw httpError(400, 'email, phone, name, and password are required');

    const normalizedEmail = String(email).toLowerCase().trim();
    const normalizedPhone = String(phone).trim();
    const existing = await prisma.account.findFirst({ where: { OR: [{ email: normalizedEmail }, { phone: normalizedPhone }] } });
    if (existing) throw httpError(409, 'An account with this email or phone already exists');

    const passwordHash = await bcrypt.hash(String(password), 10);
    const account = await prisma.account.create({
      data: { email: normalizedEmail, phone: normalizedPhone, name: String(name).trim(), password_hash: passwordHash }
    });

    const [emailVerification, phoneVerification] = await Promise.all([
      createVerification({ accountId: account.id, channel: 'EMAIL', purpose: 'SIGNUP', target: account.email }),
      createVerification({ accountId: account.id, channel: 'PHONE', purpose: 'SIGNUP', target: account.phone })
    ]);

    await createAudit({ actorType: 'ACCOUNT', actorId: account.id, entityType: 'account', entityId: account.id, action: 'account.created' });

    return res.status(201).json({
      ok: true,
      account_id: account.id,
      verification_required: true,
      verification_channels: ['EMAIL', 'PHONE'],
      verification_code: env.isProduction ? undefined : emailVerification.code,
      phone_verification_code: env.isProduction ? undefined : phoneVerification.code
    });
  } catch (error) {
    next(error);
  }
};

exports.requestVerification = async (req, res, next) => {
  try {
    const { email, channel = 'EMAIL', purpose = 'SIGNUP' } = req.body || {};
    if (!email) throw httpError(400, 'email is required');
    const account = await prisma.account.findUnique({ where: { email: String(email).toLowerCase().trim() } });
    if (!account) throw httpError(404, 'Account not found');
    const target = channel === 'PHONE' ? account.phone : account.email;
    if (!target) throw httpError(400, `Account does not have a ${channel.toLowerCase()} target`);
    const verification = await createVerification({ accountId: account.id, channel, purpose, target });
    return res.json({ ok: true, verification_code: env.isProduction ? undefined : verification.code });
  } catch (error) {
    next(error);
  }
};

exports.verify = async (req, res, next) => {
  try {
    const { email, channel = 'EMAIL', purpose = 'SIGNUP', code } = req.body || {};
    if (!email || !code) throw httpError(400, 'email and code are required');
    const account = await prisma.account.findUnique({ where: { email: String(email).toLowerCase().trim() } });
    if (!account) throw httpError(404, 'Account not found');
    const target = channel === 'PHONE' ? account.phone : account.email;
    if (!target) throw httpError(400, `Account does not have a ${channel.toLowerCase()} target`);
    await verifyCode({ accountId: account.id, channel, purpose, target, code });

    const updateData = channel === 'EMAIL' ? { email_verified_at: new Date() } : { phone_verified_at: new Date() };
    await prisma.account.update({ where: { id: account.id }, data: updateData });
    await createAudit({ actorType: 'ACCOUNT', actorId: account.id, entityType: 'account', entityId: account.id, action: 'account.verified', metadata: { channel } });

    return res.json({ ok: true, verified: true });
  } catch (error) {
    next(error);
  }
};

exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) throw httpError(400, 'email and password are required');
    const account = await prisma.account.findUnique({ where: { email: String(email).toLowerCase().trim() } });
    if (!account) throw httpError(401, 'Invalid credentials');
    if (account.status !== 'ACTIVE') throw httpError(403, 'Account is disabled');
    if (!account.email_verified_at) throw httpError(403, 'Email verification is required before login');

    const ok = await bcrypt.compare(String(password), account.password_hash);
    if (!ok) throw httpError(401, 'Invalid credentials');

    const { token, jti } = signAccountToken({ account_id: account.id, email: account.email }, env.jwtExpiresIn);
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);

    await prisma.platformSession.create({
      data: {
        account_id: account.id,
        jti,
        ip: req.ip,
        user_agent: req.headers['user-agent'] || null,
        expires_at: expiresAt
      }
    });

    await prisma.account.update({ where: { id: account.id }, data: { last_login_at: new Date() } });

    return res.json({ ok: true, token, account: { id: account.id, email: account.email, name: account.name } });
  } catch (error) {
    next(error);
  }
};

exports.runtimeLogin = async (req, res, next) => {
  try {
    const {
      email,
      password,
      device_fingerprint,
      device_name,
      platform,
      os_version,
      app_version,
      force_takeover = false,
      force_seat_transfer = false,
      seat_transfer_user_id = null
    } = req.body || {};

    if (!email || !password) throw httpError(400, 'email and password are required');
    if (!device_fingerprint) throw httpError(400, 'device_fingerprint is required');

    let runtimeAuth;
    try {
      runtimeAuth = await authenticateRuntimeUser({ email: String(email).toLowerCase().trim(), password: String(password) });
    } catch (error) {
      const status = error?.response?.status;
      const remoteMessage = error?.response?.data?.message;
      if (status === 401) throw httpError(401, 'Invalid credentials');
      if (status === 403) throw httpError(403, remoteMessage || 'Runtime user is not allowed to login');
      throw httpError(status || 502, remoteMessage || 'Runtime authentication bridge failed');
    }

    const runtimeUser = runtimeAuth?.user;
    if (!runtimeUser) throw httpError(401, 'Invalid credentials');

    const tenant = await prisma.tenant.findFirst({
      where: { runtime_company_id: runtimeUser.company_id },
      include: {
        subscriptions: { include: { plan: true }, orderBy: { created_at: 'desc' }, take: 1 },
        devices: true
      }
    });
    if (!tenant) throw httpError(404, 'Tenant not found for runtime user');

    const { device, seatPolicy } = await upsertRuntimeDevice({
      tenant,
      accountId: tenant.owner_account_id,
      deviceFingerprint: device_fingerprint,
      deviceName: device_name,
      platform,
      osVersion: os_version,
      appVersion: app_version,
      forceTakeover: force_takeover,
      runtimeUser,
      forceSeatTransfer: force_seat_transfer,
      seatTransferUserId: seat_transfer_user_id
    });

    const { token, session, plan, role } = await createRuntimeSession({
      tenant,
      accountId: tenant.owner_account_id,
      deviceId: device.id,
      runtimeUser
    });

    await createAudit({
      actorType: 'RUNTIME_USER',
      actorId: runtimeUser.id,
      tenantId: tenant.id,
      entityType: 'runtime_session',
      entityId: session.id,
      action: 'runtime.login',
      metadata: {
        device_id: device.id,
        device_name: device.device_name,
        platform: device.platform,
        plan,
        role,
        runtime_user_id: runtimeUser.id,
        runtime_user_email: runtimeUser.email,
        runtime_user_name: runtimeUser.name,
        force_takeover,
        force_seat_transfer,
        displaced_user: seatPolicy?.displacedSeat?.runtime_user_email || null
      }
    });

    return res.json({
      ok: true,
      token,
      expires_in: env.runtimeJwtExpiresIn,
      tenant: {
        id: tenant.id,
        display_name: tenant.display_name,
        lifecycle_status: tenant.lifecycle_status,
        runtime_provision_status: tenant.runtime_provision_status
      },
      user: {
        id: runtimeUser.id,
        email: runtimeUser.email,
        name: runtimeUser.name,
        company_id: runtimeUser.company_id,
        is_admin: runtimeUser.is_admin,
        roles: runtimeUser.roles,
        role
      },
      device,
      runtime_session: { id: session.id, expires_at: session.expires_at },
      plan,
      seat_transfer: seatPolicy?.displacedSeat ? {
        from_user: seatPolicy.displacedSeat.runtime_user_email,
        session_count: seatPolicy.displacedSeat.session_ids.length
      } : null
    });
  } catch (error) {
    next(error);
  }
};

exports.me = async (req, res, next) => {
  try {
    const tenants = await prisma.tenant.findMany({
      where: { owner_account_id: req.account.id },
      include: { subscriptions: { include: { plan: true }, orderBy: { created_at: 'desc' }, take: 1 }, config: true, locations: true },
      orderBy: { created_at: 'desc' }
    });
    return res.json({
      ok: true,
      account: {
        id: req.account.id,
        email: req.account.email,
        phone: req.account.phone,
        name: req.account.name,
        email_verified_at: req.account.email_verified_at,
        phone_verified_at: req.account.phone_verified_at,
        status: req.account.status
      },
      tenants
    });
  } catch (error) {
    next(error);
  }
};

exports.logout = async (req, res, next) => {
  try {
    await prisma.platformSession.update({ where: { id: req.session.id }, data: { revoked_at: new Date() } });
    return res.json({ ok: true });
  } catch (error) {
    next(error);
  }
};
