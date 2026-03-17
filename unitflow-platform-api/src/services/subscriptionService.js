const prisma = require('../config/db');
const { env } = require('../config/env');
const { syncTenantStatus } = require('./coreSyncService');
const { createAudit } = require('./auditService');
const { createNotification } = require('./notificationService');

async function createTrialSubscription(tx, tenantId, plan) {
  const startedAt = new Date();
  const trialEndsAt = new Date(startedAt.getTime() + (plan.trial_days || env.defaultTrialDays) * 24 * 60 * 60 * 1000);
  return tx.tenantSubscription.create({
    data: {
      tenant_id: tenantId,
      plan_id: plan.id,
      billing_cycle: 'TRIAL',
      status: 'TRIAL',
      seat_limit: 1,
      plan_snapshot_json: {
        code: plan.code,
        name: plan.name,
        plan_type: plan.plan_type,
        trial_days: plan.trial_days
      },
      started_at: startedAt,
      ends_at: trialEndsAt,
      trial_started_at: startedAt,
      trial_ends_at: trialEndsAt
    }
  });
}

async function activatePaidSubscription({ tenant, plan, billingCycle, payment }) {
  const now = new Date();
  const renewsAt = new Date(now);
  if (billingCycle === 'YEARLY') renewsAt.setFullYear(renewsAt.getFullYear() + 1);
  else renewsAt.setMonth(renewsAt.getMonth() + 1);

  const subscription = await prisma.$transaction(async (tx) => {
    await tx.tenantSubscription.updateMany({
      where: { tenant_id: tenant.id, status: { in: ['TRIAL', 'ACTIVE', 'GRACE'] } },
      data: { status: 'CANCELLED', cancelled_at: now }
    });

    const created = await tx.tenantSubscription.create({
      data: {
        tenant_id: tenant.id,
        plan_id: plan.id,
        billing_cycle: billingCycle,
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
        runtime_last_synced_at: now
      }
    });

    return created;
  });

  await syncTenantStatus(tenant.id, {
    is_active: true,
    subscription_status: 'active',
    plan_code: plan.code,
    billing_cycle: billingCycle.toLowerCase(),
    active_until: renewsAt.toISOString()
  });

  await createAudit({
    actorType: 'SYSTEM',
    tenantId: tenant.id,
    entityType: 'tenant_subscription',
    entityId: subscription.id,
    action: 'subscription.activated',
    metadata: { plan_code: plan.code, billing_cycle: billingCycle }
  });

  await createNotification({
    tenantId: tenant.id,
    accountId: tenant.owner_account_id,
    type: 'subscription.activated',
    title: 'Subscription activated',
    body: `${plan.name} (${billingCycle.toLowerCase()}) is now active.`
  });

  return subscription;
}

async function applyLifecycleMaintenance() {
  const now = new Date();
  const subscriptions = await prisma.tenantSubscription.findMany({
    where: { status: { in: ['TRIAL', 'ACTIVE', 'GRACE'] } },
    include: { tenant: true, plan: true }
  });

  for (const sub of subscriptions) {
    if (sub.status === 'TRIAL' && sub.trial_ends_at && sub.trial_ends_at < now) {
      await prisma.tenantSubscription.update({ where: { id: sub.id }, data: { status: 'EXPIRED' } });
      await prisma.tenant.update({ where: { id: sub.tenant_id }, data: { lifecycle_status: 'EXPIRED' } });
      await syncTenantStatus(sub.tenant_id, { is_active: false, subscription_status: 'expired' });
    }

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

module.exports = { createTrialSubscription, activatePaidSubscription, applyLifecycleMaintenance };
