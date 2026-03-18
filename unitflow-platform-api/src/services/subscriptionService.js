const prisma = require('../config/db');
const { syncTenantStatus, provisionTenant } = require('./coreSyncService');
const { createAudit } = require('./auditService');
const { createNotification } = require('./notificationService');

function computeRenewalDate(now, billingCycle) {
  const renewsAt = new Date(now);
  if (billingCycle === 'YEARLY') renewsAt.setFullYear(renewsAt.getFullYear() + 1);
  else renewsAt.setMonth(renewsAt.getMonth() + 1);
  return renewsAt;
}

async function createCheckoutPayment(db, { tenantId, accountId, plan, billingCycle, currency = 'INR', metadata = {} }) {
  const normalizedBillingCycle = String(billingCycle).toUpperCase();
  const amountMinor = normalizedBillingCycle === 'YEARLY' ? plan.yearly_price_minor : plan.monthly_price_minor;
  return db.payment.create({
    data: {
      tenant_id: tenantId,
      gateway: 'PENDING_EXTERNAL_GATEWAY',
      amount_minor: amountMinor,
      currency,
      status: 'PENDING',
      metadata_json: {
        plan_code: plan.code,
        billing_cycle: normalizedBillingCycle,
        requested_by: accountId,
        ...metadata
      }
    }
  });
}

function buildProvisionPayload(tenant, plan, billingCycle, renewsAt) {
  const config = tenant.config || {};
  const locations = Array.isArray(tenant.locations) ? tenant.locations : [];
  if (locations.length === 0) {
    throw new Error('At least one location is required before provisioning');
  }
  if (!tenant.owner?.email || !tenant.owner?.name || !tenant.owner?.password_hash) {
    throw new Error('Tenant owner account is incomplete for provisioning');
  }

  return {
    tenant_id: tenant.id,
    company: {
      name: tenant.display_name,
      legal_name: tenant.legal_name,
      email: tenant.owner.email,
      phone: tenant.owner.phone,
      address: locations[0]?.address || null
    },
    branding: {
      tenant_slug: tenant.slug,
      app_title: config.app_title || tenant.display_name,
      theme_color: config.theme_color || '#1F6FEB',
      logo_url: config.logo_url || null,
      locale: config.locale || 'en-IN',
      timezone: config.timezone || 'Asia/Kolkata',
      invoice_header: config.invoice_header || null,
      invoice_footer: config.invoice_footer || null,
      plan_code: plan.code,
      billing_cycle: String(billingCycle).toLowerCase(),
      subscription_status: 'active',
      active_until: renewsAt.toISOString()
    },
    locations: locations.map((item) => ({
      name: item.name,
      code: item.code,
      address: item.address,
      is_active: item.is_active !== false
    })),
    admin_account: {
      email: tenant.owner.email,
      phone: tenant.owner.phone,
      name: tenant.owner.name,
      password_hash: tenant.owner.password_hash
    },
    subscription: {
      plan_code: plan.code,
      billing_cycle: String(billingCycle).toLowerCase(),
      status: 'active',
      active_until: renewsAt.toISOString()
    }
  };
}

async function ensureProvisionedForPaidTenant(tenant, plan, billingCycle, renewsAt) {
  if (tenant.runtime_provision_status === 'READY' && tenant.runtime_company_id) {
    return {
      company_id: tenant.runtime_company_id,
      admin_user_id: tenant.runtime_owner_user_id || null
    };
  }

  await prisma.tenant.update({
    where: { id: tenant.id },
    data: { onboarding_status: 'PROVISIONING', runtime_provision_status: 'IN_PROGRESS' }
  });

  try {
    const provisioned = await provisionTenant(buildProvisionPayload(tenant, plan, billingCycle, renewsAt));

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        runtime_company_id: provisioned.company_id || tenant.id,
        runtime_owner_user_id: provisioned.admin_user_id || null,
        runtime_provision_status: 'READY',
        runtime_last_synced_at: new Date(),
        onboarding_status: 'READY'
      }
    });

    return provisioned;
  } catch (error) {
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { runtime_provision_status: 'FAILED', onboarding_status: 'PROFILE_COMPLETED' }
    });
    throw error;
  }
}

async function activatePaidSubscription({ tenant, plan, billingCycle, payment }) {
  if (payment?.subscription_id) {
    const existing = await prisma.tenantSubscription.findUnique({ where: { id: payment.subscription_id }, include: { plan: true } });
    if (existing) return existing;
  }

  const normalizedBillingCycle = String(billingCycle).toUpperCase();
  const now = new Date();
  const renewsAt = computeRenewalDate(now, normalizedBillingCycle);

  await ensureProvisionedForPaidTenant(tenant, plan, normalizedBillingCycle, renewsAt);

  const subscription = await prisma.$transaction(async (tx) => {
    await tx.tenantSubscription.updateMany({
      where: { tenant_id: tenant.id, status: { in: ['ACTIVE', 'GRACE'] } },
      data: { status: 'CANCELLED', cancelled_at: now }
    });

    const created = await tx.tenantSubscription.create({
      data: {
        tenant_id: tenant.id,
        plan_id: plan.id,
        billing_cycle: normalizedBillingCycle,
        status: 'ACTIVE',
        seat_limit: plan.seat_limit,
        plan_snapshot_json: {
          code: plan.code,
          name: plan.name,
          plan_type: plan.plan_type,
          monthly_price_minor: plan.monthly_price_minor,
          yearly_price_minor: plan.yearly_price_minor
        },
        started_at: now,
        renews_at: renewsAt,
        ends_at: renewsAt
      }
    });

    if (payment?.id) {
      await tx.payment.update({ where: { id: payment.id }, data: { subscription_id: created.id } });
    }

    await tx.tenant.update({
      where: { id: tenant.id },
      data: {
        lifecycle_status: 'ACTIVE',
        runtime_last_synced_at: now,
        onboarding_status: 'READY',
        runtime_provision_status: 'READY'
      }
    });

    return created;
  });

  await syncTenantStatus(tenant.id, {
    is_active: true,
    subscription_status: 'active',
    plan_code: plan.code,
    billing_cycle: normalizedBillingCycle.toLowerCase(),
    active_until: renewsAt.toISOString(),
    trial_ends_at: null
  });

  await createAudit({
    actorType: 'SYSTEM',
    tenantId: tenant.id,
    entityType: 'tenant_subscription',
    entityId: subscription.id,
    action: 'subscription.activated',
    metadata: { plan_code: plan.code, billing_cycle: normalizedBillingCycle }
  });

  await createNotification({
    tenantId: tenant.id,
    accountId: tenant.owner_account_id,
    type: 'subscription.activated',
    title: 'Subscription activated',
    body: `${plan.name} (${normalizedBillingCycle.toLowerCase()}) is now active.`
  });

  return subscription;
}

async function applyLifecycleMaintenance() {
  const now = new Date();
  const subscriptions = await prisma.tenantSubscription.findMany({
    where: { status: { in: ['ACTIVE', 'GRACE'] } },
    include: { tenant: true, plan: true }
  });

  for (const sub of subscriptions) {
    if (sub.status === 'ACTIVE' && sub.renews_at && sub.renews_at < now) {
      await prisma.tenantSubscription.update({ where: { id: sub.id }, data: { status: 'GRACE', grace_until: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) } });
      await prisma.tenant.update({ where: { id: sub.tenant_id }, data: { lifecycle_status: 'GRACE' } });
      await syncTenantStatus(sub.tenant_id, { is_active: true, subscription_status: 'grace' });
    }

    if (sub.status === 'GRACE' && sub.grace_until && sub.grace_until < now) {
      await prisma.tenantSubscription.update({ where: { id: sub.id }, data: { status: 'EXPIRED' } });
      await prisma.tenant.update({ where: { id: sub.tenant_id }, data: { lifecycle_status: 'SUSPENDED' } });
      await syncTenantStatus(sub.tenant_id, { is_active: false, subscription_status: 'expired' });
    }
  }
}

module.exports = { createCheckoutPayment, activatePaidSubscription, applyLifecycleMaintenance };
