# Two-Phase Deployment for Trigger.dev CLI

This patch adds support for splitting the Trigger.dev deployment process into two distinct phases, enabling offline builds in CI/CD pipelines and atomic deployments with your application.

## Overview

The traditional `trigger.dev deploy` command performs both building and registration in a single step, requiring API access throughout. This new two-phase approach separates these concerns:

1. **Phase 1 (Build Only)**: Builds and pushes the Docker image without contacting the Trigger.dev API
2. **Phase 2 (Register Only)**: Registers the pre-built image with Trigger.dev

## New CLI Flags

### `--build-only`
Builds and pushes the deployment image without registering it with Trigger.dev.

### `--register-only`
Registers a previously built image with Trigger.dev without rebuilding.

### Supporting Flags
- `--registry <registry>`: Docker registry for the image (e.g., `registry.example.com`)
- `--namespace <namespace>`: Docker namespace/organization (e.g., `my-org/trigger`)
- `--tag <tag>`: Full image name and tag (overrides registry/namespace)

## Usage Examples

### Phase 1: Build Only (CI Runner)

```bash
# Basic build with registry and namespace
trigger.dev deploy --build-only --push \
  --registry registry.example.com \
  --namespace my-org/trigger

# Build with custom tag
trigger.dev deploy --build-only --push \
  --tag myregistry.com/trigger/app:v1.2.3

# Build for staging environment
trigger.dev deploy --build-only --push \
  --env staging \
  --registry registry.example.com \
  --namespace my-org/trigger
```

### Phase 2: Register Only (Deployment Job)

```bash
# Register the deployment
trigger.dev deploy --register-only

# Register without promoting to current
trigger.dev deploy --register-only --skip-promotion

# Register for staging environment
trigger.dev deploy --register-only --env staging
```

## How It Works

### Phase 1 Details

When running with `--build-only`:

1. Loads the project configuration locally
2. Compiles the Trigger.dev worker code
3. Builds a Docker image with placeholder deployment IDs
4. Pushes the image to the specified registry
5. Saves metadata to `.triggerdeploy.<env>.json` containing:
   - Project reference
   - Environment
   - Content hash
   - Image tag and digest
   - Runtime information

The build process **does not**:
- Contact the Trigger.dev API
- Require authentication (though API key can be embedded in image)
- Create a deployment record
- Run the indexing process (creates placeholder index.json)
- Discover tasks/queues (this happens on first container startup)

### Phase 2 Details

When running with `--register-only`:

1. Reads the metadata from `.triggerdeploy.<env>.json`
2. Authenticates with the Trigger.dev API
3. Calls `initializeDeployment` with type `UNMANAGED`
4. Calls `finalizeDeployment` with the image digest
5. Optionally promotes the deployment (unless `--skip-promotion`)

## Metadata File

The phases communicate through a manifest file (`.triggerdeploy.<env>.json`):

```json
{
  "projectRef": "proj_abc123",
  "environment": "prod",
  "contentHash": "abcd1234efgh5678",
  "imageTag": "registry.example.com/org/project:trigger-abcd1234",
  "imageDigest": "sha256:1234567890abcdef...",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "runtime": "node"
}
```

This file is created per environment (e.g., `.triggerdeploy.prod.json`, `.triggerdeploy.staging.json`).

## CI/CD Integration Example

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Build Trigger.dev image
        run: |
          npx trigger.dev deploy --build-only --push \
            --registry ${{ secrets.REGISTRY }} \
            --namespace ${{ vars.NAMESPACE }}
        env:
          TRIGGER_ACCESS_TOKEN: ${{ secrets.TRIGGER_ACCESS_TOKEN }}
      
      - name: Upload manifest
        uses: actions/upload-artifact@v3
        with:
          name: trigger-manifest
          path: .triggerdeploy.prod.json

  deploy:
    needs: build
    runs-on: deployment-runner
    environment: production
    steps:
      - uses: actions/checkout@v3
      
      - name: Download manifest
        uses: actions/download-artifact@v3
        with:
          name: trigger-manifest
      
      - name: Register Trigger.dev deployment
        run: npx trigger.dev deploy --register-only
        env:
          TRIGGER_ACCESS_TOKEN: ${{ secrets.TRIGGER_ACCESS_TOKEN }}
```

## Benefits

1. **Offline Builds**: Phase 1 can run without internet access to Trigger.dev
2. **Atomic Deployments**: Deploy Trigger.dev workers alongside your application
3. **Security**: Build in isolated CI environments without API credentials
4. **Flexibility**: Separate build and deployment permissions/environments
5. **Reliability**: Retry registration without rebuilding

## Compatibility

- The flags are mutually exclusive - using both together will error
- Without either flag, `deploy` behaves exactly as before (backward compatible)
- Works with existing deployment options like `--skip-promotion`, `--env`, etc.

## Implementation Notes

- Build-only mode uses placeholder values for deployment IDs ("offline")
- The image tag is generated from project ref and content hash if not specified
- Registry/namespace mismatches are detected and warned about in Phase 2
- Environment mismatches between phases are prevented with validation