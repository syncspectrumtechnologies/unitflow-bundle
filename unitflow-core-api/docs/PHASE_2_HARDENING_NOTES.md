# UnitFlow Phase 2 Hardening Notes

This package includes the following hardening work:

- renamed runtime/package identity to UnitFlow Core API
- centralized environment parsing and startup validation
- structured JSON logging + request IDs
- `/health` and `/ready` endpoints
- baseline request validation on all requests
- route-level validation on critical auth/admin/factory/client/catalog/inventory/order/invoice/payment/purchase/message/chat/broadcast/stats endpoints
- idempotency support for payment, invoice create, and campaign dispatch critical flows
- stricter CORS policy with explicit allowlists/regex patterns
- security headers via Helmet and rate limiting with optional Redis-backed storage
- activity/audit logging middleware mounted globally
- syntax check script and unit tests for authorization, tenant visibility, idempotency, validation, dispatch totals, and invoice/payment status derivation

## Important note
This phase does **not** yet add the commercial control-plane (tenant provisioning, subscriptions, licenses, artifact distribution, billing admin). That belongs to the next productization phase.
