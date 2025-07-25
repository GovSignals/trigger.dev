import {
  BuildManifest,
  serializeIndexingError,
} from "@trigger.dev/core/v3";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "std-env";
import { indexWorkerManifest } from "../indexing/indexWorkerManifest.js";
import { resolveSourceFiles } from "../utilities/sourceFiles.js";
import { execOptionsForRuntime } from "@trigger.dev/core/v3/build";

async function loadBuildManifest() {
  const manifestContents = await readFile("./build.json", "utf-8");
  const raw = JSON.parse(manifestContents);

  return BuildManifest.parse(raw);
}

async function bootstrap() {
  const buildManifest = await loadBuildManifest();

  if (typeof env.TRIGGER_API_URL !== "string") {
    console.error("TRIGGER_API_URL is not set");
    process.exit(1);
  }

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
    projectRef: env.TRIGGER_PROJECT_REF,
    deploymentId: env.TRIGGER_DEPLOYMENT_ID,
  };
}

type BootstrapResult = Awaited<ReturnType<typeof bootstrap>>;

async function indexDeployment({
  projectRef,
  deploymentId,
  buildManifest,
}: BootstrapResult) {
  const stdout: string[] = [];
  const stderr: string[] = [];

  try {
    // Parse environment variables from TRIGGER_ENV_VARS build arg
    const envVarsJson = env.TRIGGER_ENV_VARS || "{}";
    let envVars: Record<string, string> = {};
    
    try {
      envVars = JSON.parse(envVarsJson);
    } catch (e) {
      console.error("Failed to parse TRIGGER_ENV_VARS:", e);
    }

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

    await writeFile(join(process.cwd(), "index.json"), JSON.stringify(workerManifest, null, 2));

    const sourceFiles = resolveSourceFiles(buildManifest.sources, workerManifest.tasks);

    const buildPlatform = process.env.BUILDPLATFORM;
    const targetPlatform = process.env.TARGETPLATFORM;

    // Write metadata that will be needed for the background worker creation
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

    await writeFile(join(process.cwd(), "index-metadata.json"), JSON.stringify(indexMetadata, null, 2));

    console.log(
      JSON.stringify({
        message: "Indexing completed",
        buildPlatform,
        targetPlatform,
        taskCount: workerManifest.tasks.length,
      })
    );
  } catch (error) {
    const serialiedIndexError = serializeIndexingError(error, stderr.join("\n"));

    console.error("Failed to index deployment", serialiedIndexError);

    // Write error to a file so it can be retrieved after the build
    await writeFile(
      join(process.cwd(), "index-error.json"), 
      JSON.stringify({ error: serialiedIndexError }, null, 2)
    );

    process.exit(1);
  }
}

const results = await bootstrap();

await indexDeployment(results);
