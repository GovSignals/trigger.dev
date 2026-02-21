---
name: Resolve upstream merge conflicts
overview: Resolve 68 merge conflicts between the GovSignals fork (with two-phase deploy, custom images, and Kubernetes enhancements) and upstream/main, preserving all fork customizations on top of upstream's refactored code.
todos:
  - id: phase1-deletions
    content: "Bulk-resolve: git rm deleted references, git add fork-only files, accept upstream lock file"
    status: completed
  - id: phase2-packagejson
    content: "Resolve package.json: accept upstream pnpm@10.23.0 and overrides structure, re-add fork-specific overrides"
    status: completed
  - id: phase3-env
    content: "Resolve env.server.ts: accept upstream refactored schema, add DEPLOY_VERSION_SUFFIX and DEPLOY_IMAGE_OVERRIDE"
    status: completed
  - id: phase4-kubernetes
    content: "Resolve kubernetes.ts: combine fork's serviceAccountName/securityContext with upstream's schedulerName"
    status: completed
  - id: phase5-initdeploy
    content: "Resolve initializeDeployment.server.ts: keep upstream's new API, integrate fork's DEPLOY_IMAGE_OVERRIDE with rewritten else branch"
    status: completed
  - id: phase6-buildworker
    content: "Resolve buildWorker.ts: combine fork's baseImageNode/containerfileModule with upstream's plain option"
    status: completed
  - id: phase7-buildimage
    content: "Resolve buildImage.ts: combine imports, keep both indexEnvVars and compression options, keep fork's --load and image tag"
    status: completed
  - id: phase8-deploy
    content: "Resolve deploy.ts: combine imports/options from both sides, keep all new functions from both fork and upstream"
    status: completed
  - id: phase9-finalize
    content: Run pnpm install, verify build compiles, complete merge commit
    status: completed
isProject: false
---

# Resolve Upstream Merge Conflicts

The merge from `upstream/main` into the `update-trigger` branch has 68 conflicted files. The fork's custom features (two-phase deploy, custom images/containerfiles, Kubernetes service account) need to be preserved on top of upstream's refactored code.

## Phase 1: Bulk-resolve trivial conflicts

### 1a. Delete files removed by upstream

55 files in `references/seed/src copy/` and 2 files in `references/v3-catalog/` were deleted upstream. Accept the deletions.

```bash
git rm -r "references/seed/src copy/"
git rm references/v3-catalog/src/trigger/returnTypes.ts
git rm references/v3-catalog/trigger.config.ts
```

### 1b. Keep fork-only files

2 files in `references/seed/` exist only in the fork. Keep them.

```bash
git add references/seed/.triggerdeploy.json
git add references/seed/src/trigger/testTasks.ts
```

### 1c. Accept upstream's lock file

```bash
git checkout --theirs pnpm-lock.yaml
git add pnpm-lock.yaml
```

## Phase 2: package.json (root)

Two conflicts in [package.json](package.json):

- **packageManager** (line 69): Accept upstream's `pnpm@10.23.0`
- **pnpm.overrides** (line 99): Accept upstream's version (includes granular `form-data` overrides, security fixes, and `onlyBuiltDependencies`). Re-add the fork's overrides that are still needed: `ws`, `semver`, `cross-spawn`, `@babel/runtime` -- insert them into the upstream overrides block

## Phase 3: env.server.ts (webapp)

One massive conflict spanning the entire file in [apps/webapp/app/env.server.ts](apps/webapp/app/env.server.ts).

- **Accept upstream's refactored schema structure** (multi-schema composition with `GithubAppEnvSchema`, `S2EnvSchema`, `.and()` chain)
- **Add the fork's 2 custom env vars** into the upstream `EnvironmentSchema` z.object, near the deployment registry section:
  - `DEPLOY_VERSION_SUFFIX: z.string().optional()`
  - `DEPLOY_IMAGE_OVERRIDE: z.string().optional()`

## Phase 4: kubernetes.ts (supervisor)

One conflict in [apps/supervisor/src/workloadManager/kubernetes.ts](apps/supervisor/src/workloadManager/kubernetes.ts) at line 323.

Both sides add non-overlapping features to the pod spec. **Keep both**:

- Fork's `serviceAccountName` spread + `securityContext` block
- Upstream's `schedulerName` spread

## Phase 5: initializeDeployment.server.ts (webapp)

One conflict in [apps/webapp/app/v3/services/initializeDeployment.server.ts](apps/webapp/app/v3/services/initializeDeployment.server.ts) at line 122.

This is the most nuanced conflict. The resolution must:

1. **Keep upstream's new variables**: `isV4Deployment`, `registryConfig`, `deploymentShortCode`
2. **Declare fork's variables**: `let imageRef: string; let isEcr = false; let repoCreated = false;`
3. **Keep the fork's `DEPLOY_IMAGE_OVERRIDE` check** (lines 144-151) as-is
4. **Rewrite the else branch** (lines 152-183): replace the old `getDeploymentImageRef` call with upstream's new API signature, then extract `imageRef`, `isEcr`, `repoCreated` from the result

The else branch should become:

```typescript
} else {
  const [imageRefError, imageRefResult] = await tryCatch(
    getDeploymentImageRef({
      registry: registryConfig,
      projectRef: environment.project.externalRef,
      nextVersion,
      environmentType: environment.type,
      deploymentShortCode,
    })
  );

  if (imageRefError) {
    logger.error("Failed to get deployment image ref", { ... });
    throw new ServiceValidationError("Failed to get deployment image ref");
  }

  imageRef = imageRefResult.imageRef;
  isEcr = imageRefResult.isEcr;
  repoCreated = imageRefResult.repoCreated;
}
```

## Phase 6: buildWorker.ts (cli-v3)

Two conflicts in [packages/cli-v3/src/build/buildWorker.ts](packages/cli-v3/src/build/buildWorker.ts).

- **Line 38**: Keep all three options in `BuildWorkerOptions`: fork's `baseImageNode` + `containerfileModule` AND upstream's `plain`
- **Line 223**: Keep fork's `metafile.json` write and `writeContainerfile` with extra args; also accept upstream's simplified default call path

## Phase 7: buildImage.ts (cli-v3)

Five conflicts in [packages/cli-v3/src/deploy/buildImage.ts](packages/cli-v3/src/deploy/buildImage.ts).

- **Line 8 (imports)**: Combine both -- fork's `cpSync, mkdirSync`, `pathToFileURL`, `ContainerfileTemplate` AND upstream's `tryCatch`, `CliApiClient`
- **Line 161 (function params)**: Keep both `indexEnvVars` and `compression`/`compressionLevel`/`forceCompression`
- **Line 192 (interface)**: Same -- keep both sets of fields
- **Line 593 (`--load` flag)**: Keep fork's conditional `--load`
- **Line 623 (image tag)**: Keep fork's `-t options.imageTag "."` instead of upstream's bare `"."`

## Phase 8: deploy.ts (cli-v3) -- largest and most complex

Six conflicts in [packages/cli-v3/src/commands/deploy.ts](packages/cli-v3/src/commands/deploy.ts).

- **Line 3 (imports)**: Combine both -- fork's `CreateBackgroundWorkerRequestBody` AND upstream's `InitializeDeploymentRequestBody`, `GitMeta`, `DeploymentFinalizedEvent`, `DeploymentEventFromString`, `DeploymentTriggeredVia`, plus upstream's `relative` import
- **Line 93 (DeployCommandOptions)**: Keep ALL options from both sides -- fork's `registry`, `repository`, `buildOnly`, `registerOnly`, `baseImageNode`, `containerfileModule`, `skipDigest` AND upstream's `nativeBuildServer`, `detach`, `plain`, `compression`, `cacheCompression`, `compressionLevel`, `forceCompression`
- **Line 453 (buildWorker call)**: Keep all three: `baseImageNode`, `containerfileModule`, `plain`
- **Line 464 (spinner text)**: Trivial -- use upstream's `"Successfully built code"` (no trailing period)
- **Line 618 (build options)**: Keep both `indexEnvVars` and compression options
- **Line 1080 (large block)**: Both sides add entirely new functions. **Keep both**: fork's `buildOnlyDeploy` + `registerOnlyDeploy` AND upstream's `initializeOrAttachDeployment` + `getTriggeredVia` + `handleNativeBuildServerDeploy`

## Phase 9: Final steps

1. Run `pnpm install` to regenerate `pnpm-lock.yaml`
2. Verify the build compiles: `pnpm run build --filter webapp --filter trigger.dev --filter @trigger.dev/sdk`
3. Complete the merge commit

