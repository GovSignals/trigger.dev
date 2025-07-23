#!/bin/bash
set -e

echo "=== Two-Phase Deployment Test Script ==="
echo ""
echo "This script demonstrates the two-phase deployment workflow for Trigger.dev CLI"
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test directory setup
TEST_DIR="/tmp/trigger-test-project"
echo -e "${BLUE}Setting up test project in ${TEST_DIR}${NC}"
rm -rf $TEST_DIR
mkdir -p $TEST_DIR
cd $TEST_DIR

# Create a minimal trigger.config.ts
cat > trigger.config.ts << 'EOF'
export default {
  project: "test-project-123",
  dirs: ["./src/trigger"],
};
EOF

# Create a sample trigger task
mkdir -p src/trigger
cat > src/trigger/hello.ts << 'EOF'
import { task } from "@trigger.dev/sdk/v3";

export const helloTask = task({
  id: "hello-world",
  run: async () => {
    console.log("Hello from Trigger.dev!");
    return { message: "Task completed successfully" };
  },
});
EOF

# Create package.json
cat > package.json << 'EOF'
{
  "name": "test-trigger-project",
  "version": "1.0.0",
  "dependencies": {
    "@trigger.dev/sdk": "^3.0.0"
  }
}
EOF

echo ""
echo -e "${GREEN}Test project created successfully${NC}"
echo ""
echo "=== Phase 1: Build Only ==="
echo ""
echo "Command that would be run:"
echo -e "${YELLOW}trigger.dev deploy --build-only --push --registry registry.example.com --namespace my-org/trigger${NC}"
echo ""
echo "This would:"
echo "1. Build the trigger code locally"
echo "2. Create a Docker image with the compiled code"
echo "3. Push it to registry.example.com/my-org/trigger/test-project-123:trigger-<hash>"
echo "4. Save metadata to .triggerdeploy.prod.json"
echo ""
echo "Expected output:"
echo "- Version built and pushed to registry.example.com/my-org/trigger/test-project-123:trigger-abcd1234"
echo "- Manifest saved to .triggerdeploy.prod.json"
echo ""

# Create a sample manifest file that would be generated
cat > .triggerdeploy.prod.json << 'EOF'
{
  "projectRef": "test-project-123",
  "environment": "prod",
  "contentHash": "abcd1234efgh5678ijkl9012mnop3456",
  "imageTag": "registry.example.com/my-org/trigger/test-project-123:trigger-abcd1234",
  "imageDigest": "sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "runtime": "node"
}
EOF

echo -e "${GREEN}Sample manifest file created${NC}"
echo ""
echo "=== Phase 2: Register Only ==="
echo ""
echo "Command that would be run:"
echo -e "${YELLOW}trigger.dev deploy --register-only${NC}"
echo ""
echo "This would:"
echo "1. Read the manifest from .triggerdeploy.prod.json"
echo "2. Call initializeDeployment API with type: UNMANAGED"
echo "3. Call finalizeDeployment API with the image digest"
echo "4. Register the deployment without building"
echo ""
echo "Expected output:"
echo "- Deployment version 123 has been registered successfully"
echo "- 1 task detected | View deployment | Test tasks"
echo ""

# Show the manifest content
echo "=== Manifest Content ==="
cat .triggerdeploy.prod.json | jq '.' 2>/dev/null || cat .triggerdeploy.prod.json
echo ""

echo -e "${GREEN}Test completed successfully!${NC}"
echo ""
echo "=== Usage Examples ==="
echo ""
echo "Build only (CI runner):"
echo "  trigger.dev deploy --build-only --push --registry \$REGISTRY --namespace \$NAMESPACE"
echo ""
echo "Register only (deployment job):"
echo "  trigger.dev deploy --register-only"
echo ""
echo "With custom tag:"
echo "  trigger.dev deploy --build-only --tag myregistry.com/trigger/app:v1.2.3"
echo ""
echo "Skip promotion:"
echo "  trigger.dev deploy --register-only --skip-promotion"
echo ""