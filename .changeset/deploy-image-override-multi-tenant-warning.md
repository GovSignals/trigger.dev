---
"trigger.dev": minor
---

webapp: clarify DEPLOY_IMAGE_OVERRIDE is single-tenant only

The `DEPLOY_IMAGE_OVERRIDE` env var forces every deployment finalized by the webapp to use the configured image, ignoring the registry config / per-deployment image computation. Useful for self-hosted single-tenant installs where CI builds one canonical tasks image; dangerous on cloud / multi-tenant where deployments come from untrusted user code. No behavior change — just adds a strong warning docstring to `apps/webapp/app/env.server.ts` calling out the multi-tenant foot-gun.
