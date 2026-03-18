const prisma = require('../config/db');
const httpError = require('../utils/httpError');
const { safeSlug } = require('../utils/security');
const { createAudit } = require('../services/auditService');
const { createNotification } = require('../services/notificationService');
const { getPlanByCode } = require('../services/planService');
const { createCheckoutPayment } = require('../services/subscriptionService');
const { env } = require('../config/env');
const { queueProvisioning, buildProvisioningVersion } = require('../services/provisioningService');

async function assertOwner(tenantId, accountId) {
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, owner_account_id: accountId },
    include: {
      owner: { select: { id: true, email: true, phone: true, name: true, email_verified_at: true, phone_verified_at: true } },
      config: true,
      locations: true,
      subscriptions: { include: { plan: true }, orderBy: { created_at: 'desc' }, take: 1 }
    }
  });
  if (!tenant) throw httpError(404, 'Tenant not found');
  return tenant;
}

async function buildUniqueSlug(rawSlug, currentTenantId = null) {
  const desiredSlug = safeSlug(rawSlug);
  if (!desiredSlug) throw httpError(400, 'A valid slug or display_name is required');

  let uniqueSlug = desiredSlug;
  let counter = 1;
  while (true) {
    const existing = await prisma.tenant.findUnique({ where: { slug: uniqueSlug } });
    if (!existing || existing.id === currentTenantId) return uniqueSlug;
    counter += 1;
    uniqueSlug = `${desiredSlug}-${counter}`;
  }
}

async function findReusableTenant(accountId) {
  return prisma.tenant.findFirst({
    where: {
      owner_account_id: accountId,
      lifecycle_status: { in: ['TRIAL_PENDING', 'TRIAL_ACTIVE', 'SUSPENDED', 'CANCELLED', 'EXPIRED'] }
    },
    include: {
      subscriptions: { where: { status: { in: ['ACTIVE', 'GRACE'] } }, take: 1 },
      config: true,
      locations: true
    },
    orderBy: { created_at: 'desc' }
  });
}

exports.onboardPaidTenant = async (req, res, next) => {
  try {
    const {
      display_name,
      legal_name,
      business_type,
      slug,
      branding = {},
      locations = [],
      plan_code,
      billing_cycle
    } = req.body || {};

    if (!display_name) throw httpError(400, 'display_name is required');
    if (!Array.isArray(locations) || locations.length === 0) throw httpError(400, 'At least one location is required');
    if (!plan_code || !billing_cycle) throw httpError(400, 'plan_code and billing_cycle are required');
    if (!['SINGLE_USER', 'MULTI_USER'].includes(String(plan_code).toUpperCase())) throw httpError(400, 'plan_code must be SINGLE_USER or MULTI_USER');
    if (!['MONTHLY', 'YEARLY'].includes(String(billing_cycle).toUpperCase())) throw httpError(400, 'billing_cycle must be MONTHLY or YEARLY');
    if (!req.account.email_verified_at || !req.account.phone_verified_at) throw httpError(403, 'Email and phone verification are required before onboarding');

    const plan = await getPlanByCode(String(plan_code).toUpperCase());
    if (!plan) throw httpError(404, 'Selected plan is not available');

    const activeTenant = await prisma.tenant.findFirst({
      where: { owner_account_id: req.account.id, lifecycle_status: { in: ['ACTIVE', 'GRACE'] } },
      include: { subscriptions: { where: { status: { in: ['ACTIVE', 'GRACE'] } }, take: 1 } }
    });
    if (activeTenant) throw httpError(409, 'This account already has an active workspace');

    const reusableTenant = await findReusableTenant(req.account.id);
    const uniqueSlug = await buildUniqueSlug(slug || display_name, reusableTenant?.id || null);
    const normalizedBillingCycle = String(billing_cycle).toUpperCase();

    const tenant = await prisma.$transaction(async (tx) => {
      let workspace;

      if (reusableTenant) {
        workspace = await tx.tenant.update({
          where: { id: reusableTenant.id },
          data: {
            slug: uniqueSlug,
            display_name: String(display_name).trim(),
            legal_name: legal_name !== undefined ? String(legal_name || '').trim() || null : reusableTenant.legal_name,
            business_type: business_type !== undefined ? String(business_type || '').trim() || null : reusableTenant.business_type,
            onboarding_status: 'PROFILE_COMPLETED',
            lifecycle_status: 'SUSPENDED',
            runtime_provision_status: 'PAYMENT_PENDING'
          }
        });

        if (reusableTenant.config) {
          await tx.tenantConfig.update({
            where: { tenant_id: reusableTenant.id },
            data: {
              theme_color: branding.theme_color || reusableTenant.config.theme_color || '#1F6FEB',
              logo_url: branding.logo_url !== undefined ? branding.logo_url : reusableTenant.config.logo_url,
              app_title: branding.app_title || reusableTenant.config.app_title || display_name,
              invoice_header: branding.invoice_header !== undefined ? branding.invoice_header : reusableTenant.config.invoice_header,
              invoice_footer: branding.invoice_footer !== undefined ? branding.invoice_footer : reusableTenant.config.invoice_footer,
              locale: branding.locale || reusableTenant.config.locale || 'en-IN',
              timezone: branding.timezone || reusableTenant.config.timezone || 'Asia/Kolkata'
            }
          });
        } else {
          await tx.tenantConfig.create({
            data: {
              tenant_id: reusableTenant.id,
              theme_color: branding.theme_color || '#1F6FEB',
              logo_url: branding.logo_url || null,
              app_title: branding.app_title || display_name,
              invoice_header: branding.invoice_header || null,
              invoice_footer: branding.invoice_footer || null,
              locale: branding.locale || 'en-IN',
              timezone: branding.timezone || 'Asia/Kolkata'
            }
          });
        }

        await tx.tenantLocation.deleteMany({ where: { tenant_id: reusableTenant.id } });
        for (const item of locations) {
          await tx.tenantLocation.create({
            data: {
              tenant_id: reusableTenant.id,
              name: item.name,
              code: item.code || null,
              address: item.address || null,
              is_active: item.is_active !== false
            }
          });
        }

        await tx.payment.updateMany({
          where: { tenant_id: reusableTenant.id, status: 'PENDING' },
          data: { status: 'FAILED', audit_trail_json: { cancelled_at: new Date().toISOString(), reason: 'superseded_by_new_checkout' } }
        });
      } else {
        workspace = await tx.tenant.create({
          data: {
            owner_account_id: req.account.id,
            slug: uniqueSlug,
            display_name: String(display_name).trim(),
            legal_name: legal_name ? String(legal_name).trim() : null,
            business_type: business_type ? String(business_type).trim() : null,
            onboarding_status: 'PROFILE_COMPLETED',
            lifecycle_status: 'SUSPENDED',
            runtime_provision_status: 'PAYMENT_PENDING'
          }
        });

        await tx.tenantConfig.create({
          data: {
            tenant_id: workspace.id,
            theme_color: branding.theme_color || '#1F6FEB',
            logo_url: branding.logo_url || null,
            app_title: branding.app_title || display_name,
            invoice_header: branding.invoice_header || null,
            invoice_footer: branding.invoice_footer || null,
            locale: branding.locale || 'en-IN',
            timezone: branding.timezone || 'Asia/Kolkata'
          }
        });

        for (const item of locations) {
          await tx.tenantLocation.create({
            data: {
              tenant_id: workspace.id,
              name: item.name,
              code: item.code || null,
              address: item.address || null,
              is_active: item.is_active !== false
            }
          });
        }
      }

      const payment = await createCheckoutPayment(tx, {
        tenantId: workspace.id,
        accountId: req.account.id,
        plan,
        billingCycle: normalizedBillingCycle,
        currency: env.defaultCurrency,
        metadata: { source: 'self_serve_onboarding', display_name: String(display_name).trim() }
      });

      return { ...workspace, payment };
    });

    await createAudit({
      actorType: 'ACCOUNT',
      actorId: req.account.id,
      tenantId: tenant.id,
      entityType: 'tenant',
      entityId: tenant.id,
      action: 'tenant.onboarding.checkout_created',
      metadata: { plan_code: plan.code, billing_cycle: normalizedBillingCycle, payment_id: tenant.payment.id }
    });

    await createNotification({
      tenantId: tenant.id,
      accountId: req.account.id,
      type: 'tenant.payment_pending',
      title: 'Complete your payment',
      body: `Your ${plan.name} ${normalizedBillingCycle.toLowerCase()} subscription checkout is ready.`
    });

    return res.status(201).json({
      ok: true,
      tenant_id: tenant.id,
      lifecycle_status: 'SUSPENDED',
      runtime_provision_status: 'PAYMENT_PENDING',
      onboarding_status: 'PROFILE_COMPLETED',
      plan_code: plan.code,
      billing_cycle: normalizedBillingCycle,
      payment: {
        id: tenant.payment.id,
        amount_minor: tenant.payment.amount_minor,
        currency: tenant.payment.currency,
        status: tenant.payment.status,
        gateway: tenant.payment.gateway
      }
    });
  } catch (error) {
    next(error);
  }
};

exports.listMine = async (req, res, next) => {
  try {
    const tenants = await prisma.tenant.findMany({
      where: { owner_account_id: req.account.id },
      include: {
        owner: { select: { id: true, email: true, phone: true, name: true, email_verified_at: true, phone_verified_at: true } },
        config: true,
        locations: true,
        subscriptions: { include: { plan: true }, orderBy: { created_at: 'desc' }, take: 1 }
      },
      orderBy: { created_at: 'desc' }
    });

    res.json({
      ok: true,
      tenants: tenants.map((tenant) => ({
        ...tenant,
        provisioning_version: buildProvisioningVersion(tenant, tenant.subscriptions?.[0] || null),
        runtime_access_ready: ['READY', 'SYNC_PENDING'].includes(String(tenant.runtime_provision_status || '')) && ['ACTIVE', 'GRACE'].includes(tenant.lifecycle_status)
      }))
    });
  } catch (error) { next(error); }
};

exports.getOne = async (req, res, next) => {
  try {
    const tenant = await assertOwner(req.params.tenantId, req.account.id);
    res.json({
      ok: true,
      tenant: {
        ...tenant,
        provisioning_version: buildProvisioningVersion(tenant, tenant.subscriptions?.[0] || null),
        runtime_access_ready: ['READY', 'SYNC_PENDING'].includes(String(tenant.runtime_provision_status || '')) && ['ACTIVE', 'GRACE'].includes(tenant.lifecycle_status)
      }
    });
  } catch (error) { next(error); }
};

exports.updateConfig = async (req, res, next) => {
  try {
    const tenant = await assertOwner(req.params.tenantId, req.account.id);
    const { branding = {}, locations, company = {} } = req.body || {};

    await prisma.$transaction(async (tx) => {
      await tx.tenant.update({
        where: { id: tenant.id },
        data: {
          display_name: company.display_name || undefined,
          legal_name: company.legal_name !== undefined ? company.legal_name : undefined,
          business_type: company.business_type !== undefined ? company.business_type : undefined,
          onboarding_status: tenant.runtime_provision_status === 'READY' ? 'READY' : tenant.onboarding_status
        }
      });
      await tx.tenantConfig.update({
        where: { tenant_id: tenant.id },
        data: {
          theme_color: branding.theme_color || undefined,
          logo_url: branding.logo_url !== undefined ? branding.logo_url : undefined,
          app_title: branding.app_title || undefined,
          invoice_header: branding.invoice_header !== undefined ? branding.invoice_header : undefined,
          invoice_footer: branding.invoice_footer !== undefined ? branding.invoice_footer : undefined,
          locale: branding.locale || undefined,
          timezone: branding.timezone || undefined
        }
      });
      if (Array.isArray(locations)) {
        await tx.tenantLocation.deleteMany({ where: { tenant_id: tenant.id } });
        for (const item of locations) {
          await tx.tenantLocation.create({
            data: { tenant_id: tenant.id, name: item.name, code: item.code || null, address: item.address || null, is_active: item.is_active !== false }
          });
        }
      }
    });

    let queueResult = null;
    if (tenant.runtime_company_id) {
      queueResult = await queueProvisioning({ tenantId: tenant.id, reason: 'config_update', actorType: 'ACCOUNT', actorId: req.account.id });
    }

    await createAudit({ actorType: 'ACCOUNT', actorId: req.account.id, tenantId: tenant.id, entityType: 'tenant', entityId: tenant.id, action: 'tenant.config.updated', metadata: { queued_sync: Boolean(queueResult) } });
    res.json({ ok: true, synced: false, provisioning: queueResult });
  } catch (error) { next(error); }
};

exports.retryProvisioning = async (req, res, next) => {
  try {
    const tenant = await assertOwner(req.params.tenantId, req.account.id);
    const queued = await queueProvisioning({ tenantId: tenant.id, reason: 'owner_retry', actorType: 'ACCOUNT', actorId: req.account.id });
    res.json({ ok: true, ...queued });
  } catch (error) { next(error); }
};
