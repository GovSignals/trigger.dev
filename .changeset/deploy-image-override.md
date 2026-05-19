---
"trigger.dev": minor
---

webapp: add `DEPLOY_IMAGE_OVERRIDE` env var (single-tenant only)

Adds a new `DEPLOY_IMAGE_OVERRIDE` env var on the webapp. When set, every deployment finalized by this webapp instance is wired to the configured image reference instead of being routed through the default per-deployment image computation (`getDeploymentImageRef`). Useful for self-hosted single-tenant installs where CI builds one canonical tasks image per release and the chart-managed registry / per-project tagging is unnecessary.

⚠️ **WARNING: SINGLE-TENANT ONLY.** This is a foot-gun on cloud / multi-tenant installs where deployments come from untrusted user code: a single operator-set value silently overrides every tenant's per-project image. The env var ships unset by default; the docstring in `apps/webapp/app/env.server.ts` and this changeset call out the risk. Leave unset on multi-tenant installs.
