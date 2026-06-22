# Offline-build flow (`TRIGGER_INDEX_OFFLINE=1`)

This document covers the build pipeline for operators who need to build a
tasks image **without calling out to a live trigger.dev API at build time**
— e.g. air-gapped or regulated build environments where the build host
cannot reach the webapp the image will eventually be deployed against.

## How it works

Two pieces compose:

1. `TRIGGER_INDEX_OFFLINE=1` switches the in-image indexer to a stub
   `CliApiClient` that writes deployment metadata to disk instead of
   POST-ing it to the API. See
   [`packages/cli-v3/src/entryPoints/managed-index-controller.ts`](../src/entryPoints/managed-index-controller.ts)
   (`createOfflineCliApiClient`). The shim implements only the three
   methods that `indexDeployment` actually calls:
   - `getEnvironmentVariables()` → returns `{}` (no project env vars
     reachable at build time)
   - `createDeploymentBackgroundWorker(_id, body)` → writes
     `index-metadata.json` to `process.cwd()`
   - `failDeployment(_id, body)` → writes `index-error.json`
2. The build script (a small `build.mjs` driven by `@trigger.dev/cli-v3`'s
   `internal` subpath — see [`packages/cli-v3/src/internal.ts`](../src/internal.ts))
   passes `offlineIndex: true` to `buildImage` and `--containerfile-module=<path>`
   to use a custom Containerfile generator. See
   [`packages/cli-v3/src/deploy/buildImage.ts`](../src/deploy/buildImage.ts) —
   when `offlineIndex: true`, the generated Containerfile sets
   `ARG TRIGGER_INDEX_OFFLINE` and forwards it as a build arg into the
   indexer stage; the final stage copies `/app/index-metadata.json` into
   the runtime image at `/app/`.

The metadata gets baked into the runtime image, then re-played against
the real webapp API later by a separate **register** process running
inside the cluster (where it _can_ reach the webapp). The register
process uses the same image, reads `/app/index-metadata.json`, hits the
real webapp API via `getProjectClient`, and finalizes the deployment.

## Operator responsibilities

- Provide a `containerfileModule` if the default Containerfile doesn't fit
  (e.g. base on UBI / chainguard / a FIPS-validated runtime). The module's
  job is to emit the multi-stage Containerfile text that invokes the
  indexer stage with `TRIGGER_INDEX_OFFLINE=1` and copies
  `/app/index-metadata.json` into the final image.
- Run your `build.mjs` equivalent on the build host (no API access
  required). The output is just the tasks image pushed to your registry.
- Run your `register.mjs` equivalent on the deploy host (Kubernetes Job /
  systemd unit / etc.) using **the same image**. It reads
  `/app/index-metadata.json` and re-issues `createDeploymentBackgroundWorker`
  against the live webapp.

## Caveats

- Project env vars are **not** available at build time in offline mode.
  Any task whose indexing step depends on a project env var will index
  with `{}`. If your tasks need env vars at index time, use the online
  flow.
- The offline shim returns synthetic `id: "offline"` / `version: "offline"`
  from `createDeploymentBackgroundWorker`. Anything in your build pipeline
  reading those fields must be aware that the real id/version is assigned
  later, by the register step.
- `TRIGGER_INDEX_OFFLINE=1` only affects the indexer stage. The rest of
  the runtime (the tasks themselves) still talks to the live API at
  runtime as normal.
