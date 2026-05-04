// Example Distroless containerfile template for maximum security
// Distroless images contain only the application and runtime dependencies
// No shell, package managers, or other unnecessary binaries
// Usage: npx trigger.dev@latest deploy --containerfile-module ./distroless-containerfile.mjs

import { parseGenerateOptions } from '@trigger.dev/cli-v3/dist/deploy/buildImage.js';

export default {
  async generate(options) {
    const { indexScript, entrypoint } = options;
    const { baseImage, buildArgs, buildEnvVars, postInstallCommands } = parseGenerateOptions(options);
    
    // Use the base image for building, but distroless for final stage
    return `# syntax=docker/dockerfile:1
# Build stage - using regular node image for building
FROM ${baseImage} AS build

# Install build dependencies
RUN apt-get update && \\
  apt-get install -y --no-install-recommends python3 make g++ && \\
  apt-get clean && \\
  rm -rf /var/lib/apt/lists/*

WORKDIR /app

${buildArgs}

${buildEnvVars}

ENV NODE_ENV=production
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# Copy and install dependencies
COPY package.json ./
RUN npm ci --production --no-audit --no-fund

# Copy application files
COPY . .

${postInstallCommands}

# Indexer stage - still needs full node for running indexer
FROM ${baseImage} AS indexer

WORKDIR /app

# Copy from build stage
COPY --from=build /app ./

ARG TRIGGER_PROJECT_ID
ARG TRIGGER_DEPLOYMENT_ID
ARG TRIGGER_DEPLOYMENT_VERSION
ARG TRIGGER_CONTENT_HASH
ARG TRIGGER_PROJECT_REF
ARG NODE_EXTRA_CA_CERTS
ARG TRIGGER_SECRET_KEY
ARG TRIGGER_API_URL
ARG TRIGGER_PREVIEW_BRANCH
ARG TRIGGER_INDEX_OFFLINE

ENV TRIGGER_PROJECT_ID=\${TRIGGER_PROJECT_ID} \\
    TRIGGER_DEPLOYMENT_ID=\${TRIGGER_DEPLOYMENT_ID} \\
    TRIGGER_DEPLOYMENT_VERSION=\${TRIGGER_DEPLOYMENT_VERSION} \\
    TRIGGER_PROJECT_REF=\${TRIGGER_PROJECT_REF} \\
    TRIGGER_CONTENT_HASH=\${TRIGGER_CONTENT_HASH} \\
    TRIGGER_SECRET_KEY=\${TRIGGER_SECRET_KEY} \\
    TRIGGER_API_URL=\${TRIGGER_API_URL} \\
    TRIGGER_PREVIEW_BRANCH=\${TRIGGER_PREVIEW_BRANCH} \\
    TRIGGER_LOG_LEVEL=debug \\
    NODE_EXTRA_CA_CERTS=\${NODE_EXTRA_CA_CERTS} \\
    TRIGGER_INDEX_OFFLINE=\${TRIGGER_INDEX_OFFLINE} \\
    NODE_ENV=production \\
    NODE_OPTIONS="--max_old_space_size=8192"

ARG TARGETPLATFORM
ARG BUILDPLATFORM
ENV BUILDPLATFORM=$BUILDPLATFORM TARGETPLATFORM=$TARGETPLATFORM

# Run the indexer
RUN node ${indexScript}

# Final stage - using distroless for minimal attack surface
FROM gcr.io/distroless/nodejs20-debian12:nonroot AS final

WORKDIR /app

ARG TRIGGER_PROJECT_ID
ARG TRIGGER_DEPLOYMENT_ID
ARG TRIGGER_DEPLOYMENT_VERSION
ARG TRIGGER_CONTENT_HASH
ARG TRIGGER_PROJECT_REF
ARG NODE_EXTRA_CA_CERTS

ENV TRIGGER_PROJECT_ID=\${TRIGGER_PROJECT_ID} \\
    TRIGGER_DEPLOYMENT_ID=\${TRIGGER_DEPLOYMENT_ID} \\
    TRIGGER_DEPLOYMENT_VERSION=\${TRIGGER_DEPLOYMENT_VERSION} \\
    TRIGGER_CONTENT_HASH=\${TRIGGER_CONTENT_HASH} \\
    TRIGGER_PROJECT_REF=\${TRIGGER_PROJECT_REF} \\
    UV_USE_IO_URING=0 \\
    NODE_EXTRA_CA_CERTS=\${NODE_EXTRA_CA_CERTS} \\
    NODE_ENV=production

# Copy application from build stage
# Note: distroless runs as nonroot user by default (UID 65532)
COPY --from=build --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /app/package.json ./package.json
COPY --from=build --chown=65532:65532 /app/dist ./dist
COPY --from=build --chown=65532:65532 /app/.trigger ./.trigger

# Copy index files from indexer stage
COPY --from=indexer --chown=65532:65532 /app/index.json ./
COPY --from=indexer --chown=65532:65532 /app/index-metadata.json ./
# index-error.json is optional
COPY --from=indexer --chown=65532:65532 /app/index-error.json* ./

# Distroless doesn't have dumb-init, but it's not needed
# as distroless properly handles signals
ENTRYPOINT ["node", "${entrypoint}"]
`;
  }
}; 