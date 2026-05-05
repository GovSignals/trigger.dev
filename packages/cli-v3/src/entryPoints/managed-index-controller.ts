import {
  BuildManifest,
  CreateBackgroundWorkerRequestBody,
  serializeIndexingError,
} from "@trigger.dev/core/v3";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "std-env";
import { CliApiClient } from "../apiClient.js";
import { indexWorkerManifest } from "../indexing/indexWorkerManifest.js";
import { resolveSourceFiles } from "../utilities/sourceFiles.js";
import { execOptionsForRuntime } from "@trigger.dev/core/v3/build";
import { writeJSONFile } from "../utilities/fileSystem.js";

async function loadBuildManifest() {
  const manifestContents = await readFile("./build.json", "utf-8");
  const raw = JSON.parse(manifestContents);

  return BuildManifest.parse(raw);
}

async function bootstrap() {
  const buildManifest = await loadBuildManifest();

  // Offline mode (TRIGGER_INDEX_OFFLINE=1): swap in a CliApiClient shim that
  // writes the same payloads to disk that the real client would have sent
  // over the wire. indexDeployment is unchanged — it just gets a different
  // implementation of the same interface.
  if (env.TRIGGER_INDEX_OFFLINE === "1") {
    return {
      buildManifest,
      cliApiClient: createOfflineCliApiClient(),
      // The shim ignores these but the shape needs to match.
      projectRef: env.TRIGGER_PROJECT_REF ?? "offline",
      deploymentId: env.TRIGGER_DEPLOYMENT_ID ?? "offline",
    };
  }

  if (typeof env.TRIGGER_API_URL !== "string") {
    console.error("TRIGGER_API_URL is not set");
    process.exit(1);
  }

  const cliApiClient = new CliApiClient(
    env.TRIGGER_API_URL,
    env.TRIGGER_SECRET_KEY,
    env.TRIGGER_PREVIEW_BRANCH
  );

  if (!env.TRIGGER_PROJECT_REF) {
    console.error("TRIGGER_PROJECT_REF is not set");
    process.exit(1);
  }

  if (!env.TRIGGER_DEPLOYMENT_ID) {
    console.error("TRIGGER_DEPLOYMENT_ID is not set");
    process.exit(1);
  }

  return {
    buildManifest,
    cliApiClient,
    projectRef: env.TRIGGER_PROJECT_REF,
    deploymentId: env.TRIGGER_DEPLOYMENT_ID,
  };
}

type BootstrapResult = Awaited<ReturnType<typeof bootstrap>>;

async function indexDeployment({
  cliApiClient,
  projectRef,
  deploymentId,
  buildManifest,
}: BootstrapResult) {
  const stdout: string[] = [];
  const stderr: string[] = [];

  try {
    const $env = await cliApiClient.getEnvironmentVariables(projectRef);

    if (!$env.success) {
      throw new Error(`Failed to fetch environment variables: ${$env.error}`);
    }

    const workerManifest = await indexWorkerManifest({
      runtime: buildManifest.runtime,
      indexWorkerPath: buildManifest.indexWorkerEntryPoint,
      buildManifestPath: "./build.json",
      nodeOptions: execOptionsForRuntime(buildManifest.runtime, buildManifest),
      env: $env.data.variables,
      otelHookExclude: buildManifest.otelImportHook?.exclude,
      otelHookInclude: buildManifest.otelImportHook?.include,
      handleStdout(data) {
        stdout.push(data);
      },
      handleStderr(data) {
        if (!data.includes("DeprecationWarning")) {
          stderr.push(data);
        }
      },
    });

    console.log("Writing index.json", process.cwd());

    const { timings, ...manifestWithoutTimings } = workerManifest;
    await writeJSONFile(join(process.cwd(), "index.json"), manifestWithoutTimings, true);

    const sourceFiles = resolveSourceFiles(buildManifest.sources, workerManifest.tasks);

    const buildPlatform = process.env.BUILDPLATFORM;
    const targetPlatform = process.env.TARGETPLATFORM;

    const backgroundWorkerBody: CreateBackgroundWorkerRequestBody = {
      localOnly: true,
      metadata: {
        contentHash: buildManifest.contentHash,
        packageVersion: buildManifest.packageVersion,
        cliPackageVersion: buildManifest.cliPackageVersion,
        tasks: workerManifest.tasks,
        queues: workerManifest.queues,
        sourceFiles,
        runtime: workerManifest.runtime,
        runtimeVersion: workerManifest.runtimeVersion,
      },
      engine: "V2",
      supportsLazyAttempts: true,
      buildPlatform,
      targetPlatform,
    };

    const createResponse = await cliApiClient.createDeploymentBackgroundWorker(
      deploymentId,
      backgroundWorkerBody
    );

    if (!createResponse.success) {
      console.error(
        JSON.stringify({
          message: "Failed to create background worker",
          buildPlatform,
          targetPlatform,
          error: createResponse.error,
        })
      );
      // Do NOT fail the deployment, this may be a multi-platform deployment
      return;
    }

    console.log(
      JSON.stringify({
        message: "Background worker created",
        buildPlatform,
        targetPlatform,
        createResponse: createResponse.data,
      })
    );
  } catch (error) {
    const serialiedIndexError = serializeIndexingError(error, stderr.join("\n"));

    console.error("Failed to index deployment", serialiedIndexError);

    await cliApiClient.failDeployment(deploymentId, { error: serialiedIndexError });

    process.exit(1);
  }
}

/**
 * Stub `CliApiClient` for offline indexing (TRIGGER_INDEX_OFFLINE=1).
 *
 * indexDeployment makes three calls on the API client:
 *
 *   1. `getEnvironmentVariables(projectRef)` — returns an empty `variables`
 *      map. The build container has no API access in offline mode, so we
 *      can't fetch project env vars; the indexer runs with `{}`.
 *   2. `createDeploymentBackgroundWorker(deploymentId, body)` — writes the
 *      flattened body to `index-metadata.json`. Downstream tooling (e.g.
 *      a register-only Job in the cluster) re-issues this payload to the
 *      real API.
 *   3. `failDeployment(deploymentId, body)` — writes the error to
 *      `index-error.json`.
 *
 * The multi-stage Containerfile copies these files into the final image so
 * downstream tooling reads them out of the runtime image.
 *
 * Cast through `unknown` because `CliApiClient` is a concrete class with
 * private fields and methods we don't need to stub. indexDeployment only
 * touches the three methods above.
 */
function createOfflineCliApiClient(): CliApiClient {
  return {
    async getEnvironmentVariables() {
      return { success: true as const, data: { variables: {} as Record<string, string> } };
    },
    async createDeploymentBackgroundWorker(
      _deploymentId: string,
      body: CreateBackgroundWorkerRequestBody
    ) {
      const indexMetadata = {
        ...body.metadata,
        buildPlatform: body.buildPlatform,
        targetPlatform: body.targetPlatform,
      };
      await writeFile(
        join(process.cwd(), "index-metadata.json"),
        JSON.stringify(indexMetadata, null, 2)
      );
      return {
        success: true as const,
        data: {
          id: "offline",
          version: "offline",
          contentHash: body.metadata.contentHash,
        },
      };
    },
    async failDeployment(_deploymentId: string, body: { error: unknown }) {
      await writeFile(
        join(process.cwd(), "index-error.json"),
        JSON.stringify(body, null, 2)
      );
      return { success: true as const, data: { id: "offline" } };
    },
  } as unknown as CliApiClient;
}

const results = await bootstrap();

await indexDeployment(results);
