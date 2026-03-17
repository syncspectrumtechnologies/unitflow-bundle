# UnitFlow Phase 1 Architecture Freeze

## Official v1 deployment modes

### 1. SaaS shared runtime
Used for monthly and yearly subscriptions.
- One UnitFlow runtime serves many tenants.
- All customer traffic goes through UnitFlow API.
- Tenants are isolated at the application/data-access layer.
- Customers never receive database credentials.

### 2. Dedicated hosted runtime
Used for premium and one-time purchase customers.
- Separate backend runtime and separate database.
- Customer still uses the same API contract and desktop app.
- Infrastructure secrets remain server-side only.

## Explicitly out of v1
- Offline/local-first runtime
- Desktop app direct database access
- Database URL as license key
- Customer-managed schema forks as the default customization model

## Electron decision
Electron is a secure desktop shell over frontend + API only.
It is **not** a database client.

## Productization principle
Customization defaults to:
1. configuration
2. feature flags
3. templates / branding
4. scoped enterprise forks only when contractually justified
