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
 *   2. **Offline mode (opt-in via `TRIGGER_ENV_VARS` build arg)**:
 *      - Reads environment variables from the `TRIGGER_ENV_VARS` JSON build arg
 *        (no API access required).
 *      - Writes `index-metadata.json` (and `index-error.json` on failure) to
 *        disk for the host-side CLI to read after the build.
 *      - Used by `trigger deploy --build-only` followed by
 *        `trigger deploy --register-only` to support build-and-register
 *        workflows where the build container has no network access to the API.
 *
 * Mode is selected by the presence of the `TRIGGER_ENV_VARS` env var. If unset,
 * the controller behaves exactly as it did before two-phase deploy was added.
 */

async function loadBuildManifest() {
  const manifestContents = await readFile("./build.json", "utf-8");
  const raw = JSON.parse(manifestContents);

  return BuildManifest.parse(raw);
}

type OnlineBootstrap = {
  mode: "online";
  buildManifest: BuildManifest;
  cliApiClient: CliApiClient;
  projectRef: string;
  deploymentId: string;
};

type OfflineBootstrap = {
  mode: "offline";
  buildManifest: BuildManifest;
  envVars: Record<string, string>;
};

type BootstrapResult = OnlineBootstrap | OfflineBootstrap;

async function bootstrap(): Promise<BootstrapResult> {
  const buildManifest = await loadBuildManifest();

  // Offline mode: env vars are baked in via TRIGGER_ENV_VARS build arg.
  if (typeof env.TRIGGER_ENV_VARS === "string") {
    let envVars: Record<string, string> = {};
    try {
      const parsed = JSON.parse(env.TRIGGER_ENV_VARS);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        Object.values(parsed).every((v) => typeof v === "string")
      ) {
        envVars = parsed as Record<string, string>;
      } else {
        console.error(
          "TRIGGER_ENV_VARS must be a JSON object of string values; got:",
          env.TRIGGER_ENV_VARS
        );
        process.exit(1);
      }
    } catch (e) {
      console.error("Failed to parse TRIGGER_ENV_VARS:", e);
      process.exit(1);
    }

    return {
      mode: "offline",
      buildManifest,
      envVars,
    };
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
    mode: "online",
    buildManifest,
    cliApiClient,
    projectRef: env.TRIGGER_PROJECT_REF,
    deploymentId: env.TRIGGER_DEPLOYMENT_ID,
  };
}

async function indexDeployment(result: BootstrapResult) {
  const { buildManifest } = result;
  const stdout: string[] = [];
  const stderr: string[] = [];

  try {
    const envVars =
      result.mode === "offline"
        ? result.envVars
        : await (async () => {
            const $env = await result.cliApiClient.getEnvironmentVariables(result.projectRef);
            if (!$env.success) {
              throw new Error(`Failed to fetch environment variables: ${$env.error}`);
            }
            return $env.data.variables;
          })();

    const workerManifest = await indexWorkerManifest({
      runtime: buildManifest.runtime,
      indexWorkerPath: buildManifest.indexWorkerEntryPoint,
      buildManifestPath: "./build.json",
      nodeOptions: execOptionsForRuntime(buildManifest.runtime, buildManifest),
      env: envVars,
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

    if (result.mode === "offline") {
      // Two-phase deploy: write metadata to disk for the host CLI to register
      // after the build via `trigger deploy --register-only`.
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

    const createResponse = await result.cliApiClient.createDeploymentBackgroundWorker(
      result.deploymentId,
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

    if (result.mode === "offline") {
      // Write error to a file so the host CLI can retrieve it after the build.
      await writeFile(
        join(process.cwd(), "index-error.json"),
        JSON.stringify({ error: serialiedIndexError }, null, 2)
      );
    } else {
      await result.cliApiClient.failDeployment(result.deploymentId, { error: serialiedIndexError });
    }

    process.exit(1);
  }
}

const results = await bootstrap();

await indexDeployment(results);
