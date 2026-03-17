const bcrypt = require('bcrypt');
const prisma = require('../config/db');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeColor(value, fallback = '#1F6FEB') {
  const candidate = String(value || '').trim();
  return /^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/.test(candidate) ? candidate : fallback;
}

function sanitizeString(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const str = String(value).trim();
  return str.length ? str : fallback;
}

async function upsertCompanyConfig(tx, companyId, payload = {}) {
  return tx.companyPlatformConfig.upsert({
    where: { company_id: companyId },
    update: {
      tenant_slug: sanitizeString(payload.tenant_slug),
      app_title: sanitizeString(payload.app_title, 'UnitFlow'),
      theme_color: normalizeColor(payload.theme_color),
      logo_url: sanitizeString(payload.logo_url),
      locale: sanitizeString(payload.locale, 'en-IN'),
      timezone: sanitizeString(payload.timezone, 'Asia/Kolkata'),
      invoice_header: sanitizeString(payload.invoice_header),
      invoice_footer: sanitizeString(payload.invoice_footer),
      plan_code: sanitizeString(payload.plan_code),
      billing_cycle: sanitizeString(payload.billing_cycle),
      subscription_status: sanitizeString(payload.subscription_status, 'trial'),
      trial_ends_at: payload.trial_ends_at ? new Date(payload.trial_ends_at) : null,
      active_until: payload.active_until ? new Date(payload.active_until) : null,
      platform_last_synced_at: new Date()
    },
    create: {
      company_id: companyId,
      tenant_slug: sanitizeString(payload.tenant_slug),
      app_title: sanitizeString(payload.app_title, 'UnitFlow'),
      theme_color: normalizeColor(payload.theme_color),
      logo_url: sanitizeString(payload.logo_url),
      locale: sanitizeString(payload.locale, 'en-IN'),
      timezone: sanitizeString(payload.timezone, 'Asia/Kolkata'),
      invoice_header: sanitizeString(payload.invoice_header),
      invoice_footer: sanitizeString(payload.invoice_footer),
      plan_code: sanitizeString(payload.plan_code),
      billing_cycle: sanitizeString(payload.billing_cycle),
      subscription_status: sanitizeString(payload.subscription_status, 'trial'),
      trial_ends_at: payload.trial_ends_at ? new Date(payload.trial_ends_at) : null,
      active_until: payload.active_until ? new Date(payload.active_until) : null,
      platform_last_synced_at: new Date()
    }
  });
}


const { comparePassword } = require('../utils/password');
const { getUserRoles } = require('../services/authSessionService');

exports.authenticateRuntimeUser = async (req, res, next) => {
  try {
    const rawEmail = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!rawEmail || !password) {
      return res.status(400).json({ message: 'email and password are required' });
    }

    const user = await prisma.user.findFirst({
      where: {
        email: rawEmail,
        status: 'ACTIVE',
        company: { is: { is_active: true } }
      },
      include: {
        company: { select: { id: true, name: true, is_active: true } }
      }
    });

    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const valid = await comparePassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const roles = await getUserRoles(user.company_id, user);
    const role = user.is_admin ? 'ADMIN' : (roles[0] || 'STAFF');

    return res.json({
      ok: true,
      user: {
        id: user.id,
        company_id: user.company_id,
        email: user.email,
        name: user.name,
        is_admin: user.is_admin,
        roles,
        role
      },
      company: {
        id: user.company.id,
        name: user.company.name,
        is_active: user.company.is_active
      }
    });
  } catch (error) {
    return next(error);
  }
};

exports.provisionTenant = async (req, res, next) => {
  try {
    const {
      tenant_id,
      company = {},
      branding = {},
      locations = [],
      admin_account = {},
      subscription = {}
    } = req.body || {};

    if (!tenant_id) {
      return res.status(400).json({ message: 'tenant_id is required' });
    }
    if (!company.name) {
      return res.status(400).json({ message: 'company.name is required' });
    }
    if (!admin_account.email || (!admin_account.password && !admin_account.password_hash) || !admin_account.name) {
      return res.status(400).json({ message: 'admin_account email, name, and password or password_hash are required' });
    }

    const passwordHash = admin_account.password_hash || (admin_account.password ? await bcrypt.hash(String(admin_account.password), 10) : null);

    const result = await prisma.$transaction(async (tx) => {
      const existingCompany = await tx.company.findUnique({ where: { id: tenant_id } });

      const companyRecord = existingCompany
        ? await tx.company.update({
            where: { id: tenant_id },
            data: {
              name: company.name,
              legal_name: sanitizeString(company.legal_name),
              gstin: sanitizeString(company.gstin),
              phone: sanitizeString(company.phone),
              email: sanitizeString(company.email),
              address: sanitizeString(company.address),
              is_active: true
            }
          })
        : await tx.company.create({
            data: {
              id: tenant_id,
              name: company.name,
              legal_name: sanitizeString(company.legal_name),
              gstin: sanitizeString(company.gstin),
              phone: sanitizeString(company.phone),
              email: sanitizeString(company.email),
              address: sanitizeString(company.address),
              is_active: true
            }
          });

      await upsertCompanyConfig(tx, companyRecord.id, {
        tenant_slug: sanitizeString(branding.tenant_slug),
        app_title: sanitizeString(branding.app_title, company.name),
        theme_color: normalizeColor(branding.theme_color),
        logo_url: sanitizeString(branding.logo_url),
        locale: sanitizeString(branding.locale, 'en-IN'),
        timezone: sanitizeString(branding.timezone, 'Asia/Kolkata'),
        invoice_header: sanitizeString(branding.invoice_header),
        invoice_footer: sanitizeString(branding.invoice_footer),
        plan_code: sanitizeString(subscription.plan_code),
        billing_cycle: sanitizeString(subscription.billing_cycle),
        subscription_status: sanitizeString(subscription.status, 'trial'),
        trial_ends_at: subscription.trial_ends_at,
        active_until: subscription.active_until
      });

      await tx.factory.deleteMany({ where: { company_id: companyRecord.id } });
      for (const item of asArray(locations)) {
        await tx.factory.create({
          data: {
            company_id: companyRecord.id,
            name: item.name,
            code: sanitizeString(item.code),
            address: sanitizeString(item.address),
            is_active: item.is_active !== false
          }
        });
      }

      const existingUser = await tx.user.findFirst({
        where: {
          company_id: companyRecord.id,
          email: admin_account.email
        }
      });

      const adminUser = existingUser
        ? await tx.user.update({
            where: { id: existingUser.id },
            data: {
              name: admin_account.name,
              phone: sanitizeString(admin_account.phone),
              password_hash: passwordHash,
              status: 'ACTIVE',
              is_admin: true,
              provider: 'LOCAL'
            }
          })
        : await tx.user.create({
            data: {
              company_id: companyRecord.id,
              email: admin_account.email,
              phone: sanitizeString(admin_account.phone),
              name: admin_account.name,
              password_hash: passwordHash,
              status: 'ACTIVE',
              is_admin: true,
              provider: 'LOCAL'
            }
          });

      return {
        company_id: companyRecord.id,
        admin_user_id: adminUser.id
      };
    });

    return res.status(201).json({ ok: true, provisioned: true, ...result });
  } catch (error) {
    return next(error);
  }
};

exports.updateTenantStatus = async (req, res, next) => {
  try {
    const { tenantId } = req.params;
    const { is_active, subscription_status, plan_code, billing_cycle, trial_ends_at, active_until } = req.body || {};

    await prisma.$transaction(async (tx) => {
      if (typeof is_active === 'boolean') {
        await tx.company.update({ where: { id: tenantId }, data: { is_active } });
      }
      await upsertCompanyConfig(tx, tenantId, {
        subscription_status,
        plan_code,
        billing_cycle,
        trial_ends_at,
        active_until
      });
    });

    return res.json({ ok: true, tenant_id: tenantId });
  } catch (error) {
    return next(error);
  }
};

exports.syncTenantConfig = async (req, res, next) => {
  try {
    const { tenantId } = req.params;
    const { company = {}, branding = {}, locations } = req.body || {};

    await prisma.$transaction(async (tx) => {
      if (Object.keys(company).length) {
        await tx.company.update({
          where: { id: tenantId },
          data: {
            name: company.name || undefined,
            legal_name: company.legal_name !== undefined ? sanitizeString(company.legal_name) : undefined,
            gstin: company.gstin !== undefined ? sanitizeString(company.gstin) : undefined,
            phone: company.phone !== undefined ? sanitizeString(company.phone) : undefined,
            email: company.email !== undefined ? sanitizeString(company.email) : undefined,
            address: company.address !== undefined ? sanitizeString(company.address) : undefined
          }
        });
      }

      await upsertCompanyConfig(tx, tenantId, {
        tenant_slug: branding.tenant_slug,
        app_title: branding.app_title,
        theme_color: branding.theme_color,
        logo_url: branding.logo_url,
        locale: branding.locale,
        timezone: branding.timezone,
        invoice_header: branding.invoice_header,
        invoice_footer: branding.invoice_footer,
        plan_code: branding.plan_code,
        billing_cycle: branding.billing_cycle,
        subscription_status: branding.subscription_status,
        trial_ends_at: branding.trial_ends_at,
        active_until: branding.active_until
      });

      if (Array.isArray(locations)) {
        await tx.factory.deleteMany({ where: { company_id: tenantId } });
        for (const item of locations) {
          await tx.factory.create({
            data: {
              company_id: tenantId,
              name: item.name,
              code: sanitizeString(item.code),
              address: sanitizeString(item.address),
              is_active: item.is_active !== false
            }
          });
        }
      }
    });

    return res.json({ ok: true, synced: true, tenant_id: tenantId });
  } catch (error) {
    return next(error);
  }
};

exports.getTenantSnapshot = async (req, res, next) => {
  try {
    const { tenantId } = req.params;
    const company = await prisma.company.findUnique({
      where: { id: tenantId },
      include: {
        factories: { select: { id: true, name: true, code: true, address: true, is_active: true } },
        platform_config: true,
        users: { where: { is_admin: true }, select: { id: true, email: true, name: true, status: true } }
      }
    });

    if (!company) {
      return res.status(404).json({ message: 'Tenant not found in core runtime' });
    }

    return res.json({ ok: true, tenant: company });
  } catch (error) {
    return next(error);
  }
};
