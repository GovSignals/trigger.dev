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

/**
 * The managed index controller runs inside the build container at deploy time
 * and indexes the user's tasks. It supports two modes:
 *
 *   1. **Online mode (default, used by Trigger.dev cloud)**:
 *      - Fetches environment variables from the API via `CliApiClient`.
 *      - Registers the resulting BackgroundWorker via the API.
 *      - Reports indexing failures via `failDeployment`.
 *
 *   2. **Offline mode (opt-in via `TRIGGER_INDEX_OFFLINE=1` build arg)**:
 *      - Skips the API entirely; no env vars are fetched, no
 *        BackgroundWorker is registered, no failures are reported.
 *      - Writes `index-metadata.json` (or `index-error.json` on failure)
 *        to the working directory inside the build container. The multi-stage
 *        Containerfile copies them into the final image so downstream tooling
 *        can read them out of the runtime image (and on failure the indexer
 *        process exits non-zero, failing the build).
 *      - Intended for self-hosted setups that drive the build via
 *        `trigger.dev/internal`'s `buildImage({ offlineIndex: true })`
 *        without API credentials in the build environment.
 *
 * Mode is selected by the `TRIGGER_INDEX_OFFLINE=1` env var.
 */

async function loadBuildManifest() {
  const manifestContents = await readFile("./build.json", "utf-8");
  const raw = JSON.parse(manifestContents);

  return BuildManifest.parse(raw);
}

// In offline mode (TRIGGER_INDEX_OFFLINE=1) the bootstrap skips API client
// construction entirely. Downstream code treats `cliApiClient === undefined`
// as the signal that we're running offline.
type BootstrapResult = {
  buildManifest: BuildManifest;
  cliApiClient?: CliApiClient;
  projectRef?: string;
  deploymentId?: string;
};

/**
 * Returns the same shape as `cliApiClient.getEnvironmentVariables` for the
 * offline path. We never have project env vars at index time in offline mode
 * (the build container has no API access), so it's just an empty `variables`
 * map wrapped in the success envelope so downstream code can branch once on
 * `$env.success`.
 */
const offlineEnvShim = () =>
  ({ success: true as const, data: { variables: {} as Record<string, string> } });

async function bootstrap(): Promise<BootstrapResult> {
  const buildManifest = await loadBuildManifest();

  // Offline mode: API access is unavailable. The artifacts produced by
  // indexDeployment are baked into the final image by the Containerfile.
  if (env.TRIGGER_INDEX_OFFLINE === "1") {
    return { buildManifest };
  }

  // Online mode (default): use the API for env vars and registration.
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

async function indexDeployment({
  cliApiClient,
  projectRef,
  deploymentId,
  buildManifest,
}: BootstrapResult) {
  const stdout: string[] = [];
  const stderr: string[] = [];

  try {
    const $env =
      cliApiClient && projectRef
        ? await cliApiClient.getEnvironmentVariables(projectRef)
        : offlineEnvShim();

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

    if (!cliApiClient || !deploymentId) {
      // Offline mode: write metadata to disk; the multi-stage Containerfile
      // copies it into the final image where downstream tooling reads it.
      const indexMetadata = {
        contentHash: buildManifest.contentHash,
        packageVersion: buildManifest.packageVersion,
        cliPackageVersion: buildManifest.cliPackageVersion,
        tasks: workerManifest.tasks,
        queues: workerManifest.queues,
        sourceFiles,
        runtime: workerManifest.runtime,
        runtimeVersion: workerManifest.runtimeVersion,
        buildPlatform,
        targetPlatform,
      };

      console.log("Writing index-metadata.json");

      await writeFile(
        join(process.cwd(), "index-metadata.json"),
        JSON.stringify(indexMetadata, null, 2)
      );

      console.log(
        JSON.stringify({
          message: "Indexing completed (offline mode)",
          buildPlatform,
          targetPlatform,
          taskCount: workerManifest.tasks.length,
        })
      );
      return;
    }

    // Online mode: register the BackgroundWorker via the API.
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

    if (cliApiClient && deploymentId) {
      await cliApiClient.failDeployment(deploymentId, { error: serialiedIndexError });
    } else {
      // Offline mode: write error to disk so downstream tooling can surface it.
      await writeFile(
        join(process.cwd(), "index-error.json"),
        JSON.stringify({ error: serialiedIndexError }, null, 2)
      );
    }

    process.exit(1);
  }
}

const results = await bootstrap();

await indexDeployment(results);
