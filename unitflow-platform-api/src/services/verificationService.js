const nodemailer = require('nodemailer');
const prisma = require('../config/db');
const { env } = require('../config/env');
const logger = require('../utils/logger');
const { generateNumericCode, hashValue } = require('../utils/security');
const httpError = require('../utils/httpError');

async function maybeSendEmail(target, subject, text) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    logger.info('Skipping outbound email because SMTP is not configured', { email_target: target, subject });
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    requireTLS: String(process.env.SMTP_STARTTLS || 'true').toLowerCase() === 'true'
  });

  await transporter.sendMail({
    from: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER,
    to: target,
    subject,
    text
  });
  return true;
}

async function createVerification({ accountId, channel, purpose, target }) {
  const code = generateNumericCode(6);
  const expiresAt = new Date(Date.now() + env.verificationCodeTtlMinutes * 60 * 1000);

  await prisma.accountVerification.create({
    data: {
      account_id: accountId,
      channel,
      purpose,
      target,
      code_hash: hashValue(code),
      expires_at: expiresAt
    }
  });

  if (channel === 'EMAIL') {
    await maybeSendEmail(target, 'UnitFlow verification code', `Your UnitFlow verification code is ${code}. It expires in ${env.verificationCodeTtlMinutes} minutes.`);
  }

  return { code, expires_at: expiresAt };
}

async function verifyCode({ accountId, channel, purpose, target, code }) {
  const record = await prisma.accountVerification.findFirst({
    where: {
      account_id: accountId,
      channel,
      purpose,
      target,
      consumed_at: null,
      expires_at: { gt: new Date() }
    },
    orderBy: { created_at: 'desc' }
  });

  if (!record) throw httpError(400, 'No active verification code found');
  if (record.code_hash !== hashValue(code)) throw httpError(400, 'Invalid verification code');

  await prisma.accountVerification.update({
    where: { id: record.id },
    data: { consumed_at: new Date() }
  });

  return record;
}

module.exports = { createVerification, verifyCode };
