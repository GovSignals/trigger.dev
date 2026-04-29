# Custom Containerfile Templates

Example containerfile templates for deploying Trigger.dev projects with custom base images for secure/compliant environments.

## Usage

Use the `--containerfile-module` flag with the deploy command:

```bash
npx trigger.dev@latest deploy --containerfile-module ./path/to/template.mjs
```

## Available Examples

### Custom Base Image (`custom-base-image.mjs`)
Shows how to use a custom base image while keeping the standard build process:
```javascript
import { parseGenerateOptions } from '@trigger.dev/cli-v3/dist/deploy/buildImage.js';

export default {
  async generate(options) {
    const parsed = parseGenerateOptions(options);
    parsed.baseImage = "my-registry.com/my-secure-node:20-hardened";
    // ... generate containerfile using parsed options
  }
};
```

### Distroless (`distroless-containerfile.mjs`)
Uses Google's distroless images for maximum security - no shell, package managers, or unnecessary binaries in the final image.

## Creating Your Own Template

Templates are JavaScript/TypeScript modules that export a default object with a `generate` function:

```javascript
export default {
  async generate(options) {
    // options contains everything you need:
    // - runtime: The build runtime (node, node-22, bun)
    // - build: Build configuration with env vars and commands
    // - image: Image configuration with packages and instructions
    // - indexScript: Path to the indexing script
    // - entrypoint: Path to the runtime entrypoint
    // - containerfileModule: Path to this module
    
    return `FROM your-base-image:latest
    # ... your containerfile
    `;
  }
};
```

### Using parseGenerateOptions

You can import `parseGenerateOptions` to leverage the built-in parsing logic:

```javascript
import { parseGenerateOptions } from '@trigger.dev/cli-v3/dist/deploy/buildImage.js';

export default {
  async generate(options) {
    const parsed = parseGenerateOptions(options);
    // parsed contains:
    // - baseImage: The resolved base image
    // - baseInstructions: Additional Dockerfile instructions
    // - buildArgs: Formatted ARG statements
    // - buildEnvVars: Formatted ENV statements
    // - packages: Space-separated package list
    // - postInstallCommands: Formatted RUN commands
    
    // Customize as needed
    parsed.baseImage = "your-custom-image";
    parsed.packages += " additional-package";
    
    // Generate your containerfile...
  }
};
```

## Options Available

The `options` parameter passed to your `generate` function contains:

```typescript
{
  runtime: "node" | "node-22" | "bun",
  build: {
    env?: Record<string, string>,
    commands?: string[]
  },
  image?: {
    pkgs?: string[],
    instructions?: string[]
  },
  indexScript: string,  // e.g., ".trigger/index.mjs"
  entrypoint: string,   // e.g., ".trigger/run.mjs"
  containerfileModule?: string  // Path to your module
}
```

## Security Considerations

When using custom base images:
1. Ensure the base image has Node.js installed matching your runtime version
2. Include required system packages for your dependencies
3. Handle user permissions appropriately (distroless runs as nonroot by default)
4. Consider using multi-stage builds to minimize final image size
5. Test thoroughly in your deployment environment

## Quick Start

To swap the base image (or do anything more invasive), create a containerfile
module like the examples above and pass it via `--containerfile-module`:

```bash
npx trigger.dev@latest deploy --containerfile-module ./containerfile.mjs
```
