const prisma = require('../config/db');
const httpError = require('../utils/httpError');
const { syncTenantConfig } = require('../services/coreSyncService');
const { createAudit } = require('../services/auditService');

async function assertOwner(tenantId, accountId) {
  const tenant = await prisma.tenant.findFirst({ where: { id: tenantId, owner_account_id: accountId }, include: { config: true, locations: true, subscriptions: { orderBy: { created_at: 'desc' }, take: 1 } } });
  if (!tenant) throw httpError(404, 'Tenant not found');
  return tenant;
}

exports.listMine = async (req, res, next) => {
  try {
    const tenants = await prisma.tenant.findMany({
      where: { owner_account_id: req.account.id },
      include: { config: true, locations: true, subscriptions: { orderBy: { created_at: 'desc' }, take: 1 } },
      orderBy: { created_at: 'desc' }
    });
    res.json({ ok: true, tenants });
  } catch (error) { next(error); }
};

exports.getOne = async (req, res, next) => {
  try {
    const tenant = await assertOwner(req.params.tenantId, req.account.id);
    res.json({ ok: true, tenant });
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
          onboarding_status: 'READY'
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

    await syncTenantConfig(tenant.id, {
      company: {
        name: company.display_name || tenant.display_name,
        legal_name: company.legal_name !== undefined ? company.legal_name : tenant.legal_name,
        address: Array.isArray(locations) && locations[0] ? locations[0].address || null : undefined,
        email: req.account.email,
        phone: req.account.phone
      },
      branding,
      locations: Array.isArray(locations) ? locations : undefined
    });

    await createAudit({ actorType: 'ACCOUNT', actorId: req.account.id, tenantId: tenant.id, entityType: 'tenant', entityId: tenant.id, action: 'tenant.config.updated' });
    res.json({ ok: true, synced: true });
  } catch (error) { next(error); }
};
