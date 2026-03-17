const prisma = require('../config/db');
const { env } = require('../config/env');
const httpError = require('../utils/httpError');
const { safeSlug } = require('../utils/security');
const { getPlanByCode } = require('../services/planService');
const { createTrialSubscription } = require('../services/subscriptionService');
const { createAudit } = require('../services/auditService');
const { createNotification } = require('../services/notificationService');
const { provisionTenant } = require('../services/coreSyncService');

exports.startTrial = async (req, res, next) => {
  try {
    const { display_name, legal_name, business_type, slug, branding = {}, locations = [] } = req.body || {};
    if (!display_name) throw httpError(400, 'display_name is required');
    if (!Array.isArray(locations) || locations.length === 0) throw httpError(400, 'At least one location is required');
    if (locations.length > env.trialMaxLocations) throw httpError(400, `Trial is limited to ${env.trialMaxLocations} locations`);

    const singlePlan = await getPlanByCode('SINGLE_USER');
    if (!singlePlan) throw httpError(500, 'Default plans are not seeded');

    const desiredSlug = safeSlug(slug || display_name);
    let uniqueSlug = desiredSlug;
    let counter = 1;
    while (await prisma.tenant.findUnique({ where: { slug: uniqueSlug } })) {
      counter += 1;
      uniqueSlug = `${desiredSlug}-${counter}`;
    }

    const result = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          owner_account_id: req.account.id,
          slug: uniqueSlug,
          display_name,
          legal_name,
          business_type,
          onboarding_status: 'PROVISIONING',
          lifecycle_status: 'TRIAL_PENDING'
        }
      });

      await tx.tenantConfig.create({
        data: {
          tenant_id: tenant.id,
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
            tenant_id: tenant.id,
            name: item.name,
            code: item.code || null,
            address: item.address || null,
            is_active: item.is_active !== false
          }
        });
      }

      const trialSub = await createTrialSubscription(tx, tenant.id, singlePlan);
      return { tenant, trialSub };
    });

    try {
      await provisionTenant({
        tenant_id: result.tenant.id,
        company: {
          name: display_name,
          legal_name,
          email: req.account.email,
          phone: req.account.phone,
          address: locations[0]?.address || null
        },
        branding: {
          tenant_slug: result.tenant.slug,
          app_title: branding.app_title || display_name,
          theme_color: branding.theme_color || '#1F6FEB',
          logo_url: branding.logo_url || null,
          locale: branding.locale || 'en-IN',
          timezone: branding.timezone || 'Asia/Kolkata',
          invoice_header: branding.invoice_header || null,
          invoice_footer: branding.invoice_footer || null
        },
        locations,
        admin_account: {
          email: req.account.email,
          phone: req.account.phone,
          name: req.account.name,
          password_hash: req.account.password_hash
        },
        subscription: {
          plan_code: 'SINGLE_USER',
          billing_cycle: 'trial',
          status: 'trial',
          trial_ends_at: result.trialSub.trial_ends_at?.toISOString(),
          active_until: result.trialSub.trial_ends_at?.toISOString()
        }
      });

      await prisma.tenant.update({
        where: { id: result.tenant.id },
        data: {
          runtime_company_id: result.tenant.id,
          runtime_provision_status: 'READY',
          runtime_last_synced_at: new Date(),
          onboarding_status: 'READY',
          lifecycle_status: 'TRIAL_ACTIVE',
          trial_started_at: result.trialSub.trial_started_at,
          trial_ends_at: result.trialSub.trial_ends_at
        }
      });
    } catch (syncError) {
      await prisma.tenant.update({ where: { id: result.tenant.id }, data: { runtime_provision_status: 'FAILED', onboarding_status: 'DRAFT' } });
      throw httpError(502, 'Tenant trial created but runtime provisioning failed', { tenant_id: result.tenant.id, core_error: syncError.message });
    }

    await createAudit({ actorType: 'ACCOUNT', actorId: req.account.id, tenantId: result.tenant.id, entityType: 'tenant', entityId: result.tenant.id, action: 'trial.started' });
    await createNotification({ tenantId: result.tenant.id, accountId: req.account.id, type: 'trial.started', title: 'Trial activated', body: 'Your UnitFlow self-serve trial is now active.' });

    return res.status(201).json({ ok: true, tenant_id: result.tenant.id, trial_status: 'TRIAL_ACTIVE', trial_ends_at: result.trialSub.trial_ends_at });
  } catch (error) {
    next(error);
  }
};
