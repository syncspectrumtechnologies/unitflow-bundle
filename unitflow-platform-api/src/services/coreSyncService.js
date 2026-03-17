const axios = require('axios');
const { env } = require('../config/env');
const logger = require('../utils/logger');

function client() {
  return axios.create({
    baseURL: env.coreApiBaseUrl,
    timeout: 15000,
    headers: {
      'X-Platform-Api-Key': env.platformInternalApiKey,
      'Content-Type': 'application/json'
    }
  });
}

async function provisionTenant(payload) {
  logger.info('Provisioning tenant in core runtime', { tenant_id: payload.tenant_id });
  const res = await client().post('/internal/platform/tenants/provision', payload);
  return res.data;
}

async function syncTenantStatus(tenantId, payload) {
  const res = await client().put(`/internal/platform/tenants/${tenantId}/status`, payload);
  return res.data;
}

async function syncTenantConfig(tenantId, payload) {
  const res = await client().put(`/internal/platform/tenants/${tenantId}/config`, payload);
  return res.data;
}

async function authenticateRuntimeUser(payload) {
  const res = await client().post('/internal/platform/runtime/authenticate', payload);
  return res.data;
}

module.exports = { provisionTenant, syncTenantStatus, syncTenantConfig, authenticateRuntimeUser };
