const prisma = require('../config/db');
const httpError = require('../utils/httpError');
const { getPlanByCode } = require('../services/planService');
const { activatePaidSubscription } = require('../services/subscriptionService');
const { createAudit } = require('../services/auditService');

exports.createCheckoutIntent = async (req, res, next) => {
  try {
    const { tenant_id, plan_code, billing_cycle } = req.body || {};
    if (!tenant_id || !plan_code || !billing_cycle) throw httpError(400, 'tenant_id, plan_code, billing_cycle are required');
    const tenant = await prisma.tenant.findFirst({ where: { id: tenant_id, owner_account_id: req.account.id } });
    if (!tenant) throw httpError(404, 'Tenant not found');
    const plan = await getPlanByCode(plan_code);
    if (!plan) throw httpError(404, 'Plan not found');

    const amountMinor = billing_cycle === 'YEARLY' ? plan.yearly_price_minor : plan.monthly_price_minor;
    const payment = await prisma.payment.create({
      data: {
        tenant_id,
        gateway: 'PENDING_EXTERNAL_GATEWAY',
        amount_minor: amountMinor,
        currency: process.env.DEFAULT_CURRENCY || 'INR',
        status: 'PENDING',
        metadata_json: { plan_code, billing_cycle, requested_by: req.account.id }
      }
    });

    res.status(201).json({ ok: true, payment_id: payment.id, amount_minor: amountMinor, currency: payment.currency, plan_code, billing_cycle });
  } catch (error) { next(error); }
};

exports.paymentWebhook = async (req, res, next) => {
  try {
    const secret = req.headers['x-payment-webhook-secret'];
    if (!secret || secret !== process.env.PAYMENT_WEBHOOK_SECRET) throw httpError(401, 'Invalid webhook secret');

    const { payment_id, tenant_id, plan_code, billing_cycle, gateway, gateway_order_ref, gateway_payment_ref, status, invoice_ref, receipt_url, metadata } = req.body || {};
    if (!payment_id || !tenant_id || !plan_code || !billing_cycle || !status) throw httpError(400, 'payment_id, tenant_id, plan_code, billing_cycle, status are required');

    const tenant = await prisma.tenant.findUnique({ where: { id: tenant_id } });
    if (!tenant) throw httpError(404, 'Tenant not found');

    let payment = await prisma.payment.findUnique({ where: { id: payment_id } });
    if (!payment) throw httpError(404, 'Payment not found');

    payment = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        gateway,
        gateway_order_ref,
        gateway_payment_ref,
        status,
        invoice_ref,
        receipt_url,
        paid_at: status === 'SUCCEEDED' ? new Date() : null,
        metadata_json: metadata || undefined,
        audit_trail_json: { last_webhook_at: new Date().toISOString(), status }
      }
    });

    if (status === 'SUCCEEDED') {
      const plan = await getPlanByCode(plan_code);
      if (!plan) throw httpError(404, 'Plan not found');
      const sub = await activatePaidSubscription({ tenant, plan, billingCycle: billing_cycle, payment });
      await createAudit({ actorType: 'SYSTEM', tenantId: tenant.id, entityType: 'payment', entityId: payment.id, action: 'payment.succeeded', metadata: { subscription_id: sub.id } });
    } else {
      await createAudit({ actorType: 'SYSTEM', tenantId: tenant.id, entityType: 'payment', entityId: payment.id, action: 'payment.updated', metadata: { status } });
    }

    res.json({ ok: true });
  } catch (error) { next(error); }
};

exports.listPayments = async (req, res, next) => {
  try {
    const payments = await prisma.payment.findMany({
      where: { tenant: { owner_account_id: req.account.id } },
      orderBy: { created_at: 'desc' }
    });
    res.json({ ok: true, payments });
  } catch (error) { next(error); }
};
