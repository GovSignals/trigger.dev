// Example showing how to use a custom base image
// This imports parseGenerateOptions to leverage the built-in parsing logic
// Usage: npx trigger.dev@latest deploy --containerfile-module ./custom-base-image.mjs

import { parseGenerateOptions } from '@trigger.dev/cli-v3/dist/deploy/buildImage.js';

export default {
  async generate(options) {
    // Use parseGenerateOptions and override the base image
    const parsed = parseGenerateOptions(options);
    
    // Override with your custom base image
    parsed.baseImage = "my-registry.com/my-secure-node:20-hardened";
    
    // Generate the standard Node containerfile with your custom base
    const { indexScript, entrypoint } = options;
    
    return `# syntax=docker/dockerfile:1
FROM ${parsed.baseImage} AS base

${parsed.baseInstructions}

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && \\
  apt-get --fix-broken install -y && \\
  apt-get install -y --no-install-recommends ${parsed.packages} && \\
  apt-get clean && rm -rf /var/lib/apt/lists/*

FROM base AS build

# Install build dependencies
RUN apt-get update && \\
  apt-get install -y --no-install-recommends python3 make g++ && \\
  apt-get clean && \\
  rm -rf /var/lib/apt/lists/*

USER node
WORKDIR /app

${parsed.buildArgs}

${parsed.buildEnvVars}

ENV NODE_ENV=production
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

COPY --chown=node:node package.json ./
RUN npm i --no-audit --no-fund --no-save --no-package-lock

# Copy all files
COPY --chown=node:node . .

${parsed.postInstallCommands}

# Fix for Prisma issue
COPY --chown=node:node . .

FROM build AS indexer

USER node
WORKDIR /app

ARG TRIGGER_PROJECT_ID
ARG TRIGGER_DEPLOYMENT_ID
ARG TRIGGER_DEPLOYMENT_VERSION
ARG TRIGGER_CONTENT_HASH
ARG TRIGGER_PROJECT_REF
ARG NODE_EXTRA_CA_CERTS
ARG TRIGGER_SECRET_KEY
ARG TRIGGER_API_URL
ARG TRIGGER_PREVIEW_BRANCH
ARG TRIGGER_ENV_VARS

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
    TRIGGER_ENV_VARS=\${TRIGGER_ENV_VARS} \\
    NODE_ENV=production \\
    NODE_OPTIONS="--max_old_space_size=8192"

ARG TARGETPLATFORM
ARG BUILDPLATFORM
ENV BUILDPLATFORM=$BUILDPLATFORM TARGETPLATFORM=$TARGETPLATFORM

# Run the indexer
RUN node ${indexScript}

FROM base AS final

USER node
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

# Copy files from build stage
COPY --from=build --chown=node:node /app ./

# Copy index files from indexer stage
COPY --from=indexer --chown=node:node /app/index.json ./
COPY --from=indexer --chown=node:node /app/index-metadata.json ./
# index-error.json is optional
COPY --from=indexer --chown=node:node /app/index-error.json* ./

ENTRYPOINT [ "dumb-init", "node", "${entrypoint}" ]
CMD []
`;
  }
}; 