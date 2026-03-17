const bcrypt = require('bcrypt');
const prisma = require('../config/db');
const { env } = require('../config/env');
const httpError = require('../utils/httpError');
const { signAccountToken } = require('../utils/security');
const { createVerification, verifyCode } = require('../services/verificationService');
const { createAudit } = require('../services/auditService');

exports.signup = async (req, res, next) => {
  try {
    const { email, phone, name, password } = req.body || {};
    if (!email || !name || !password) throw httpError(400, 'email, name, and password are required');

    const existing = await prisma.account.findFirst({ where: { OR: [{ email }, ...(phone ? [{ phone }] : [])] } });
    if (existing) throw httpError(409, 'An account with this email or phone already exists');

    const passwordHash = await bcrypt.hash(String(password), 10);
    const account = await prisma.account.create({
      data: { email: String(email).toLowerCase().trim(), phone: phone ? String(phone).trim() : null, name: String(name).trim(), password_hash: passwordHash }
    });

    const verification = await createVerification({
      accountId: account.id,
      channel: 'EMAIL',
      purpose: 'SIGNUP',
      target: account.email
    });

    await createAudit({ actorType: 'ACCOUNT', actorId: account.id, entityType: 'account', entityId: account.id, action: 'account.created' });

    return res.status(201).json({
      ok: true,
      account_id: account.id,
      verification_required: true,
      verification_channel: 'EMAIL',
      verification_code: env.isProduction ? undefined : verification.code
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

exports.me = async (req, res, next) => {
  try {
    const tenants = await prisma.tenant.findMany({ where: { owner_account_id: req.account.id }, include: { subscriptions: { orderBy: { created_at: 'desc' }, take: 1 }, config: true } });
    return res.json({ ok: true, account: { id: req.account.id, email: req.account.email, phone: req.account.phone, name: req.account.name, email_verified_at: req.account.email_verified_at, phone_verified_at: req.account.phone_verified_at, status: req.account.status }, tenants });
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
