# Phase 3 Core ↔ Platform Integration

This core API remains the ERP/data-plane service.

New internal platform-facing routes:
- `POST /internal/platform/tenants/provision`
- `PUT /internal/platform/tenants/:tenantId/status`
- `PUT /internal/platform/tenants/:tenantId/config`
- `GET /internal/platform/tenants/:tenantId`

All routes require the shared secret configured in `PLATFORM_INTERNAL_API_KEY`.
The platform service uses these routes to provision and synchronize trial/paid tenants into the runtime ERP database.
