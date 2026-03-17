# Setup Overview

This bundle contains two separate services:

## 1. unitflow-core-api
- ERP runtime/data-plane
- uses `DATABASE_URL`
- exposes internal provisioning endpoints secured by `PLATFORM_INTERNAL_API_KEY`

## 2. unitflow-platform-api
- SaaS control-plane
- uses `PLATFORM_DATABASE_URL`
- calls the core internal endpoints using the same `PLATFORM_INTERNAL_API_KEY`

## Shared integration requirements
- `CORE_API_BASE_URL` in platform must point to the running core API
- `PLATFORM_INTERNAL_API_KEY` must be identical in both services
- databases must be separate
