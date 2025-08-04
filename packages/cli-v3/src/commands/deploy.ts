import { intro, log, outro } from "@clack/prompts";
import { getBranch, prepareDeploymentError, tryCatch } from "@trigger.dev/core/v3";
import { InitializeDeploymentResponseBody, CreateBackgroundWorkerRequestBody } from "@trigger.dev/core/v3/schemas";
import { Command, Option as CommandOption } from "commander";
import { resolve, join } from "node:path";
// import { readdir } from "node:fs/promises";
import { isCI } from "std-env";
import { x } from "tinyexec";
import { z } from "zod";
import { CliApiClient } from "../apiClient.js";
import { buildWorker } from "../build/buildWorker.js";
import { resolveAlwaysExternal } from "../build/externals.js";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  SkipLoggingError,
  wrapCommandAction,
} from "../cli/common.js";
import { loadConfig } from "../config.js";
import { buildImage } from "../deploy/buildImage.js";
import {
  checkLogsForErrors,
  checkLogsForWarnings,
  printErrors,
  printWarnings,
  saveLogs,
} from "../deploy/logs.js";
import { chalkError, cliLink, isLinksSupported, prettyError } from "../utilities/cliOutput.js";
import { loadDotEnvVars } from "../utilities/dotEnv.js";
import { isDirectory } from "../utilities/fileSystem.js";
import { setGithubActionsOutputAndEnvVars } from "../utilities/githubActions.js";
import { createGitMeta } from "../utilities/gitMeta.js";
import { printStandloneInitialBanner } from "../utilities/initialBanner.js";
import { resolveLocalEnvVars } from "../utilities/localEnvVars.js";
import { logger } from "../utilities/logger.js";
import { getProjectClient, upsertBranch } from "../utilities/session.js";
import { getTmpDir } from "../utilities/tempDirectories.js";
import { spinner } from "../utilities/windows.js";
import { login } from "./login.js";
import { archivePreviewBranch } from "./preview.js";
import { updateTriggerPackages } from "./update.js";
import { writeJSONFile, readJSONFile, pathExists } from "../utilities/fileSystem.js";
import { alwaysExternal } from "@trigger.dev/core/v3/build";
import { readdirSync } from "node:fs";

const DeployCommandOptions = CommonCommandOptions.extend({
  dryRun: z.boolean().default(false),
  skipSyncEnvVars: z.boolean().default(false),
  env: z.enum(["prod", "staging", "preview", "production"]),
  branch: z.string().optional(),
  load: z.boolean().optional(),
  config: z.string().optional(),
  projectRef: z.string().optional(),
  saveLogs: z.boolean().default(false),
  skipUpdateCheck: z.boolean().default(false),
  skipPromotion: z.boolean().default(false),
  noCache: z.boolean().default(false),
  envFile: z.string().optional(),
  // Local build options
  network: z.enum(["default", "none", "host"]).optional(),
  push: z.boolean().optional(),
  builder: z.string().default("trigger"),
  registry: z.string().optional(),
  repository: z.string().optional(),
  buildOnly: z.boolean().default(false),
  registerOnly: z.boolean().default(false),
});

type DeployCommandOptions = z.infer<typeof DeployCommandOptions>;

type Deployment = InitializeDeploymentResponseBody;

export function configureDeployCommand(program: Command) {
  return (
    commonOptions(
      program
        .command("deploy")
        .description("Deploy your Trigger.dev v3 project to the cloud.")
        .argument("[path]", "The path to the project", ".")
        .option(
          "-e, --env <env>",
          "Deploy to a specific environment (currently only prod and staging are supported)",
          "prod"
        )
        .option(
          "-b, --branch <branch>",
          "The preview branch to deploy to when passing --env preview. If not provided, we'll detect your git branch."
        )
        .option("--skip-update-check", "Skip checking for @trigger.dev package updates")
        .option("-c, --config <config file>", "The name of the config file, found at [path]")
        .option(
          "-p, --project-ref <project ref>",
          "The project ref. Required if there is no config file. This will override the project specified in the config file."
        )
        .option(
          "--dry-run",
          "Do a dry run of the deployment. This will not actually deploy the project, but will show you what would be deployed."
        )
        .option(
          "--skip-sync-env-vars",
          "Skip syncing environment variables when using the syncEnvVars extension."
        )
        .option(
          "--env-file <env file>",
          "Path to the .env file to load into the CLI process. Defaults to .env in the project directory."
        )
        .option(
          "--skip-promotion",
          "Skip promoting the deployment to the current deployment for the environment."
        )
        .option("--build-only", "Build and push the worker image without registering it")
        .option("--register-only", "Register a previously built image without building")
    )
      .addOption(
        new CommandOption(
          "--no-cache",
          "Do not use the cache when building the image. This will slow down the build process but can be useful if you are experiencing issues with the cache."
        ).hideHelp()
      )
      .addOption(
        new CommandOption("--load", "Load the built image into your local docker").hideHelp()
      )
      .addOption(
        new CommandOption(
          "--no-load",
          "Do not load the built image into your local docker"
        ).hideHelp()
      )
      .addOption(
        new CommandOption(
          "--save-logs",
          "If provided, will save logs even for successful builds"
        ).hideHelp()
      )
      // Local build options
      .addOption(new CommandOption("--push", "Push the image after local builds").hideHelp())
      .addOption(
        new CommandOption("--no-push", "Do not push the image after local builds").hideHelp()
      )
      .addOption(
        new CommandOption(
          "--network <mode>",
          "The networking mode for RUN instructions when building locally"
        ).hideHelp()
      )
      .addOption(
        new CommandOption(
          "--builder <builder>",
          "The builder to use when building locally"
        ).hideHelp()
      )
      .addOption(
        new CommandOption(
          "--registry <registry>",
          "Docker registry to use for build-only mode (defaults to localhost:5001)"
        ).hideHelp()
      )
      .addOption(
        new CommandOption(
          "--repository <repository>",
          "Docker repository path to use for build-only mode (defaults to trigger/<project>)"
        ).hideHelp()
      )
      .action(async (path, options) => {
        await handleTelemetry(async () => {
          await printStandloneInitialBanner(true);
          await deployCommand(path, options);
        });
      })
  );
}

export async function deployCommand(dir: string, options: unknown) {
  return await wrapCommandAction("deployCommand", DeployCommandOptions, options, async (opts) => {
    return await _deployCommand(dir, opts);
  });
}

async function _deployCommand(dir: string, options: DeployCommandOptions) {
  intro(`Deploying project${options.skipPromotion ? " (without promotion)" : ""}`);

  if (options.buildOnly && options.registerOnly) {
    throw new Error("--build-only and --register-only cannot be used together");
  }

  const cwd = process.cwd();
  const projectPath = resolve(cwd, dir);

  verifyDirectory(dir, projectPath);

  if (options.buildOnly) {
    await buildOnlyDeploy(projectPath, dir, options);
    return;
  }

  if (options.registerOnly) {
    await registerOnlyDeploy(projectPath, dir, options);
    return;
  }

  if (!options.skipUpdateCheck) {
    await updateTriggerPackages(dir, { ...options }, true, true);
  }

  const authorization = await login({
    embedded: true,
    defaultApiUrl: options.apiUrl,
    profile: options.profile,
  });

  if (!authorization.ok) {
    if (authorization.error === "fetch failed") {
      throw new Error(
        `Failed to connect to ${authorization.auth?.apiUrl}. Are you sure it's the correct URL?`
      );
    } else {
      throw new Error(
        `You must login first. Use the \`login\` CLI command.\n\n${authorization.error}`
      );
    }
  }

  //coerce env from production to prod
  if (options.env === "production") {
    options.env = "prod";
  }

  const envVars = resolveLocalEnvVars(options.envFile);

  if (envVars.TRIGGER_PROJECT_REF) {
    logger.debug("Using project ref from env", { ref: envVars.TRIGGER_PROJECT_REF });
  }

  const resolvedConfig = await loadConfig({
    cwd: projectPath,
    overrides: { project: options.projectRef ?? envVars.TRIGGER_PROJECT_REF },
    configFile: options.config,
  });

  logger.debug("Resolved config", resolvedConfig);

  const gitMeta = await createGitMeta(resolvedConfig.workspaceDir);
  logger.debug("gitMeta", gitMeta);

  const branch =
    options.env === "preview" ? getBranch({ specified: options.branch, gitMeta }) : undefined;

  if (options.env === "preview" && !branch) {
    throw new Error(
      "Didn't auto-detect preview branch, so you need to specify one. Pass --branch <branch>."
    );
  }

  if (options.env === "preview" && branch) {
    //auto-archive a branch if the PR is merged or closed
    if (gitMeta?.pullRequestState === "merged" || gitMeta?.pullRequestState === "closed") {
      log.message(`Pull request ${gitMeta?.pullRequestNumber} is ${gitMeta?.pullRequestState}.`);
      const $buildSpinner = spinner();
      $buildSpinner.start(`Archiving preview branch: "${branch}"`);
      const result = await archivePreviewBranch(authorization, branch, resolvedConfig.project);
      $buildSpinner.stop(
        result ? `Successfully archived "${branch}"` : `Failed to archive "${branch}".`
      );
      return;
    }

    logger.debug("Upserting branch", { env: options.env, branch });
    const branchEnv = await upsertBranch({
      accessToken: authorization.auth.accessToken,
      apiUrl: authorization.auth.apiUrl,
      projectRef: resolvedConfig.project,
      branch,
      gitMeta,
    });

    logger.debug("Upserted branch env", branchEnv);

    log.success(`Using preview branch "${branch}"`);

    if (!branchEnv) {
      throw new Error(`Failed to create branch "${branch}"`);
    }
  }

  const projectClient = await getProjectClient({
    accessToken: authorization.auth.accessToken,
    apiUrl: authorization.auth.apiUrl,
    projectRef: resolvedConfig.project,
    env: options.env,
    branch,
    profile: options.profile,
  });

  if (!projectClient) {
    throw new Error("Failed to get project client");
  }

  const serverEnvVars = await projectClient.client.getEnvironmentVariables(resolvedConfig.project);
  loadDotEnvVars(resolvedConfig.workingDir, options.envFile);

  const destination = getTmpDir(resolvedConfig.workingDir, "build", options.dryRun);

  const $buildSpinner = spinner();

  const forcedExternals = await resolveAlwaysExternal(projectClient.client);

  const { features } = resolvedConfig;

  const [error, buildManifest] = await tryCatch(
    buildWorker({
      target: "deploy",
      environment: options.env,
      branch,
      destination: destination.path,
      resolvedConfig,
      rewritePaths: true,
      envVars: serverEnvVars.success ? serverEnvVars.data.variables : {},
      forcedExternals,
      listener: {
        onBundleStart() {
          $buildSpinner.start("Building trigger code");
        },
        onBundleComplete(result) {
          $buildSpinner.stop("Successfully built code.");

          logger.debug("Bundle result", result);
        },
      },
    })
  );

  if (error) {
    $buildSpinner.stop("Failed to build code");
    throw error;
  }

  logger.debug("Successfully built project to", destination.path);

  if (options.dryRun) {
    logger.info(`Dry run complete. View the built project at ${destination.path}`);
    return;
  }

  const deploymentResponse = await projectClient.client.initializeDeployment({
    contentHash: buildManifest.contentHash,
    userId: authorization.userId,
    gitMeta,
    type: features.run_engine_v2 ? "MANAGED" : "V1",
    runtime: buildManifest.runtime,
  });

  if (!deploymentResponse.success) {
    throw new Error(`Failed to start deployment: ${deploymentResponse.error}`);
  }

  const deployment = deploymentResponse.data;
  const isLocalBuild = !deployment.externalBuildData;

  // Fail fast if we know local builds will fail
  if (isLocalBuild) {
    const result = await x("docker", ["buildx", "version"]);

    if (result.exitCode !== 0) {
      logger.debug(`"docker buildx version" failed (${result.exitCode}):`, result);
      throw new Error(
        "Failed to find docker buildx. Please install it: https://github.com/docker/buildx#installing."
      );
    }
  }

  const hasVarsToSync =
    Object.keys(buildManifest.deploy.sync?.env || {}).length > 0 ||
    // Only sync parent variables if this is a branch environment
    (branch && Object.keys(buildManifest.deploy.sync?.parentEnv || {}).length > 0);

  if (hasVarsToSync) {
    const childVars = buildManifest.deploy.sync?.env ?? {};
    const parentVars = buildManifest.deploy.sync?.parentEnv ?? {};

    const numberOfEnvVars = Object.keys(childVars).length + Object.keys(parentVars).length;
    const vars = numberOfEnvVars === 1 ? "var" : "vars";

    if (!options.skipSyncEnvVars) {
      const $spinner = spinner();
      $spinner.start(`Syncing ${numberOfEnvVars} env ${vars} with the server`);

      const uploadResult = await syncEnvVarsWithServer(
        projectClient.client,
        resolvedConfig.project,
        options.env,
        childVars,
        parentVars
      );

      if (!uploadResult.success) {
        await failDeploy(
          projectClient.client,
          deployment,
          {
            name: "SyncEnvVarsError",
            message: `Failed to sync ${numberOfEnvVars} env ${vars} with the server: ${uploadResult.error}`,
          },
          "",
          $spinner
        );
      } else {
        $spinner.stop(`Successfully synced ${numberOfEnvVars} env ${vars} with the server`);
      }
    } else {
      logger.log(
        "Skipping syncing env vars. The environment variables in your project have changed, but the --skip-sync-env-vars flag was provided."
      );
    }
  }

  const version = deployment.version;

  const rawDeploymentLink = `${authorization.dashboardUrl}/projects/v3/${resolvedConfig.project}/deployments/${deployment.shortCode}`;
  const rawTestLink = `${authorization.dashboardUrl}/projects/v3/${
    resolvedConfig.project
  }/test?environment=${options.env === "prod" ? "prod" : "stg"}`;

  const deploymentLink = cliLink("View deployment", rawDeploymentLink);
  const testLink = cliLink("Test tasks", rawTestLink);

  const $spinner = spinner();

  const buildSuffix = isLocalBuild ? " (local)" : "";
  const deploySuffix = isLocalBuild ? " (local build)" : "";

  if (isCI) {
    log.step(`Building version ${version}\n`);
  } else {
    if (isLinksSupported) {
      $spinner.start(`Building version ${version}${buildSuffix} ${deploymentLink}`);
    } else {
      $spinner.start(`Building version ${version}${buildSuffix}`);
    }
  }

  const buildResult = await buildImage({
    isLocalBuild,
    noCache: options.noCache,
    deploymentId: deployment.id,
    deploymentVersion: deployment.version,
    imageTag: deployment.imageTag,
    imagePlatform: deployment.imagePlatform,
    load: options.load,
    contentHash: deployment.contentHash,
    externalBuildId: deployment.externalBuildData?.buildId,
    externalBuildToken: deployment.externalBuildData?.buildToken,
    externalBuildProjectId: deployment.externalBuildData?.projectId,
    projectId: projectClient.id,
    projectRef: resolvedConfig.project,
    apiUrl: projectClient.client.apiURL,
    apiKey: projectClient.client.accessToken!,
    branchName: branch,
    authAccessToken: authorization.auth.accessToken,
    compilationPath: destination.path,
    buildEnvVars: buildManifest.build.env,
    indexEnvVars: serverEnvVars.success ? serverEnvVars.data.variables : {},
    onLog: (logMessage) => {
      if (isCI) {
        console.log(logMessage);
        return;
      }

      if (isLinksSupported) {
        $spinner.message(
          `Building version ${version}${buildSuffix} ${deploymentLink}: ${logMessage}`
        );
      } else {
        $spinner.message(`Building version ${version}${buildSuffix}: ${logMessage}`);
      }
    },
    // Local build options
    network: options.network,
    builder: options.builder,
    push: options.push,
  });

  logger.debug("Build result", buildResult);

  const warnings = checkLogsForWarnings(buildResult.logs);

  if (!warnings.ok) {
    await failDeploy(
      projectClient.client,
      deployment,
      { name: "BuildError", message: warnings.summary },
      buildResult.logs,
      $spinner,
      warnings.warnings,
      warnings.errors
    );

    throw new SkipLoggingError("Failed to build image");
  }

  if (!buildResult.ok) {
    await failDeploy(
      projectClient.client,
      deployment,
      { name: "BuildError", message: buildResult.error },
      buildResult.logs,
      $spinner,
      warnings.warnings
    );

    throw new SkipLoggingError("Failed to build image");
  }

  // Post-build indexing: Read index files and create background worker
  // Note: This only works for local builds. For remote builds (Depot), the indexing
  // still happens during the Docker build but doesn't make API calls from within the container.
  // TODO: Consider extracting index files from remote builds or using a different approach.
  if (isLocalBuild) {
    const dockerExportPath = join(destination.path, "docker-export");
    const indexMetadataPath = join(dockerExportPath, "index-metadata.json");
    const indexErrorPath = join(dockerExportPath, "index-error.json");

    logger.debug("Checking for index files", { dockerExportPath, indexMetadataPath, indexErrorPath });

    // Verify the docker export directory exists
    if (!(await pathExists(dockerExportPath))) {
      await failDeploy(
        projectClient.client,
        deployment,
        { name: "BuildError", message: "Docker export directory not found - indexing files were not extracted from the build" },
        buildResult.logs,
        $spinner
      );
      throw new SkipLoggingError("Failed to extract indexing files from Docker build");
    }

    // Check if there was an indexing error
    if (await pathExists(indexErrorPath)) {
      const indexError = await readJSONFile(indexErrorPath);
      await failDeploy(
        projectClient.client,
        deployment,
        { name: "IndexingError", message: "Failed to index deployment" },
        buildResult.logs,
        $spinner
      );
      throw new SkipLoggingError(`Indexing failed: ${JSON.stringify(indexError.error)}`);
    }

    // Read the index metadata - this is REQUIRED
    if (!(await pathExists(indexMetadataPath))) {
      await failDeploy(
        projectClient.client,
        deployment,
        { name: "BuildError", message: "index-metadata.json not found - the Docker build did not produce required indexing output" },
        buildResult.logs,
        $spinner
      );
      throw new SkipLoggingError("Missing critical index-metadata.json file");
    }

    logger.debug("Found index-metadata.json, creating background worker");
    const indexMetadata = await readJSONFile(indexMetadataPath);
    
    if (!indexMetadata || typeof indexMetadata !== 'object') {
      await failDeploy(
        projectClient.client,
        deployment,
        { name: "BuildError", message: "index-metadata.json is invalid or empty" },
        buildResult.logs,
        $spinner
      );
      throw new SkipLoggingError("Invalid index-metadata.json file");
    }
      
      const backgroundWorkerBody: CreateBackgroundWorkerRequestBody = {
        localOnly: true,
        metadata: {
          contentHash: indexMetadata.contentHash,
          packageVersion: indexMetadata.packageVersion,
          cliPackageVersion: indexMetadata.cliPackageVersion,
          tasks: indexMetadata.tasks,
          queues: indexMetadata.queues,
          sourceFiles: indexMetadata.sourceFiles,
          runtime: indexMetadata.runtime,
          runtimeVersion: indexMetadata.runtimeVersion,
        },
        engine: "V2",
        supportsLazyAttempts: true,
        buildPlatform: indexMetadata.buildPlatform,
        targetPlatform: indexMetadata.targetPlatform,
      };

      const createResponse = await projectClient.client.createDeploymentBackgroundWorker(
        deployment.id,
        backgroundWorkerBody
      );

      if (!createResponse.success) {
        logger.error(
          JSON.stringify({
            message: "Failed to create background worker",
            buildPlatform: indexMetadata.buildPlatform,
            targetPlatform: indexMetadata.targetPlatform,
            error: createResponse.error,
          })
        );
        // Don't fail the deployment for multi-platform builds
      } else {
        logger.debug(
          JSON.stringify({
            message: "Background worker created",
            buildPlatform: indexMetadata.buildPlatform,
            targetPlatform: indexMetadata.targetPlatform,
            createResponse: createResponse.data,
          })
        );
      }
  } else {
    // Remote builds (Depot) still perform indexing and API calls during the Docker build
    logger.debug("Remote build detected - indexing won't happen here");

    throw new Error("Remote build detected - indexing won't happen here because we're not extracting the index.json file");
  }

  const getDeploymentResponse = await projectClient.client.getDeployment(deployment.id);

  if (!getDeploymentResponse.success) {
    await failDeploy(
      projectClient.client,
      deployment,
      { name: "DeploymentError", message: getDeploymentResponse.error },
      buildResult.logs,
      $spinner
    );

    throw new SkipLoggingError(getDeploymentResponse.error);
  }

  const deploymentWithWorker = getDeploymentResponse.data;

  if (!deploymentWithWorker.worker) {
    const errorData = deploymentWithWorker.errorData
      ? prepareDeploymentError(deploymentWithWorker.errorData)
      : undefined;

    await failDeploy(
      projectClient.client,
      deployment,
      {
        name: "DeploymentError",
        message: errorData?.message ?? "Failed to get deployment with worker",
      },
      buildResult.logs,
      $spinner
    );

    throw new SkipLoggingError(errorData?.message ?? "Failed to get deployment with worker");
  }

  if (isCI) {
    log.step(`Deploying version ${version}${deploySuffix}\n`);
  } else {
    if (isLinksSupported) {
      $spinner.message(`Deploying version ${version}${deploySuffix} ${deploymentLink}`);
    } else {
      $spinner.message(`Deploying version ${version}${deploySuffix}`);
    }
  }

  const finalizeResponse = await projectClient.client.finalizeDeployment(
    deployment.id,
    {
      imageDigest: buildResult.digest,
      skipPromotion: options.skipPromotion,
    },
    (logMessage) => {
      if (isCI) {
        console.log(logMessage);
        return;
      }

      if (isLinksSupported) {
        $spinner.message(
          `Deploying version ${version}${deploySuffix} ${deploymentLink}: ${logMessage}`
        );
      } else {
        $spinner.message(`Deploying version ${version}${deploySuffix}: ${logMessage}`);
      }
    }
  );

  if (!finalizeResponse.success) {
    await failDeploy(
      projectClient.client,
      deployment,
      { name: "FinalizeError", message: finalizeResponse.error },
      buildResult.logs,
      $spinner
    );

    throw new SkipLoggingError("Failed to finalize deployment");
  }

  if (isCI) {
    log.step(`Successfully deployed version ${version}${deploySuffix}`);
  } else {
    $spinner.stop(`Successfully deployed version ${version}${deploySuffix}`);
  }

  const taskCount = deploymentWithWorker.worker?.tasks.length ?? 0;

  outro(
    `Version ${version} deployed with ${taskCount} detected task${taskCount === 1 ? "" : "s"} ${
      isLinksSupported ? `| ${deploymentLink} | ${testLink}` : ""
    }`
  );

  if (!isLinksSupported) {
    console.log("View deployment");
    console.log(rawDeploymentLink);
    console.log(); // new line
    console.log("Test tasks");
    console.log(rawTestLink);
  }

  if (options.saveLogs) {
    const logPath = await saveLogs(deployment.shortCode, buildResult.logs);
    console.log(`Full build logs have been saved to ${logPath}`);
  }

  setGithubActionsOutputAndEnvVars({
    envVars: {
      TRIGGER_DEPLOYMENT_VERSION: version,
      TRIGGER_VERSION: version,
      TRIGGER_DEPLOYMENT_SHORT_CODE: deployment.shortCode,
      TRIGGER_DEPLOYMENT_URL: `${authorization.dashboardUrl}/projects/v3/${resolvedConfig.project}/deployments/${deployment.shortCode}`,
      TRIGGER_TEST_URL: `${authorization.dashboardUrl}/projects/v3/${
        resolvedConfig.project
      }/test?environment=${options.env === "prod" ? "prod" : "stg"}`,
    },
    outputs: {
      deploymentVersion: version,
      workerVersion: version,
      deploymentShortCode: deployment.shortCode,
      deploymentUrl: `${authorization.dashboardUrl}/projects/v3/${resolvedConfig.project}/deployments/${deployment.shortCode}`,
      testUrl: `${authorization.dashboardUrl}/projects/v3/${
        resolvedConfig.project
      }/test?environment=${options.env === "prod" ? "prod" : "stg"}`,
      needsPromotion: options.skipPromotion ? "true" : "false",
    },
  });
}

export async function syncEnvVarsWithServer(
  apiClient: CliApiClient,
  projectRef: string,
  environmentSlug: string,
  envVars: Record<string, string>,
  parentEnvVars?: Record<string, string>
) {
  return await apiClient.importEnvVars(projectRef, environmentSlug, {
    variables: envVars,
    parentVariables: parentEnvVars,
    override: true,
  });
}

async function failDeploy(
  client: CliApiClient,
  deployment: Deployment,
  error: { name: string; message: string },
  logs: string,
  $spinner: ReturnType<typeof spinner>,
  warnings?: string[],
  errors?: string[]
) {
  logger.debug("failDeploy", { error, logs, warnings, errors });

  $spinner.stop(`Failed to deploy project`);

  const doOutputLogs = async (prefix: string = "Error") => {
    if (logs.trim() !== "") {
      const logPath = await saveLogs(deployment.shortCode, logs);

      printWarnings(warnings);
      printErrors(errors);

      checkLogsForErrors(logs);

      outro(
        `${chalkError(`${prefix}:`)} ${
          error.message
        }. Full build logs have been saved to ${logPath}`
      );

      // Display the last few lines of the logs, remove #-prefixed ones
      const lastFewLines = logs
        .split("\n")
        .filter((line) => !line.startsWith("#"))
        .filter((line) => line.trim() !== "")
        .slice(-5)
        .join("\n");

      if (lastFewLines.trim() !== "") {
        console.log("Last few lines of logs:\n");
        console.log(lastFewLines);
      }
    } else {
      outro(`${chalkError(`${prefix}:`)} ${error.message}`);
    }
  };

  const exitCommand = (message: string) => {
    throw new SkipLoggingError(message);
  };

  const deploymentResponse = await client.getDeployment(deployment.id);

  if (!deploymentResponse.success) {
    logger.debug(`Failed to get deployment with worker: ${deploymentResponse.error}`);
  } else {
    const serverDeployment = deploymentResponse.data;

    switch (serverDeployment.status) {
      case "PENDING":
      case "DEPLOYING":
      case "BUILDING": {
        await doOutputLogs();

        await client.failDeployment(deployment.id, {
          error,
        });

        exitCommand("Failed to deploy project");

        break;
      }
      case "CANCELED": {
        await doOutputLogs("Canceled");

        exitCommand("Failed to deploy project");

        break;
      }
      case "FAILED": {
        const errorData = serverDeployment.errorData
          ? prepareDeploymentError(serverDeployment.errorData)
          : undefined;

        if (errorData) {
          prettyError(errorData.message, errorData.stack, errorData.stderr);

          if (logs.trim() !== "") {
            const logPath = await saveLogs(deployment.shortCode, logs);

            outro(`Aborting deployment. Full build logs have been saved to ${logPath}`);
          } else {
            outro(`Aborting deployment`);
          }
        } else {
          await doOutputLogs("Failed");
        }

        exitCommand("Failed to deploy project");

        break;
      }
      case "DEPLOYED": {
        await doOutputLogs("Deployed with errors");

        exitCommand("Deployed with errors");

        break;
      }
      case "TIMED_OUT": {
        await doOutputLogs("TimedOut");

        exitCommand("Timed out");

        break;
      }
    }
  }
}

/**
 * Builds the project and creates a Docker image without registering it with the server.
 * 
 * Registry and repository can be configured via:
 * - CLI options: --registry and --repository
 * - Environment variables: TRIGGER_REGISTRY and TRIGGER_REPOSITORY
 * - Defaults: localhost:5001 and trigger/<project>
 * 
 * Examples:
 * - trigger.dev deploy --build-only --registry registry.example.com --repository myorg/myproject
 * - TRIGGER_REGISTRY=gcr.io TRIGGER_REPOSITORY=myproject/trigger trigger.dev deploy --build-only
 */
async function buildOnlyDeploy(projectPath: string, dir: string, options: DeployCommandOptions) {
  intro(`Building project (build-only mode)`);
  
  if (!options.skipUpdateCheck) {
    await updateTriggerPackages(dir, { ...options }, true, true);
  }

  if (options.env === "production") {
    options.env = "prod";
  }

  const envVars = resolveLocalEnvVars(options.envFile);

  const resolvedConfig = await loadConfig({
    cwd: projectPath,
    overrides: { project: options.projectRef ?? envVars.TRIGGER_PROJECT_REF },
    configFile: options.config,
  });

  logger.debug("Resolved config", resolvedConfig);

  const gitMeta = await createGitMeta(resolvedConfig.workspaceDir);
  logger.debug("gitMeta", gitMeta);
  
  const branch =
    options.env === "preview" ? getBranch({ specified: options.branch, gitMeta }) : undefined;

  if (options.env === "preview" && !branch) {
    throw new Error(
      "Didn't auto-detect preview branch, so you need to specify one. Pass --branch <branch>."
    );
  }

  loadDotEnvVars(resolvedConfig.workingDir, options.envFile);

  const destination = getTmpDir(resolvedConfig.workingDir, "build", options.dryRun);

  const $buildSpinner = spinner();

  const buildManifest = await buildWorker({
    target: "deploy",
    environment: options.env,
    branch,
    destination: destination.path,
    resolvedConfig,
    rewritePaths: true,
    envVars: {}, // No server env vars in build-only mode
    forcedExternals: alwaysExternal,
    listener: {
      onBundleStart() {
        $buildSpinner.start("Building trigger code");
      },
      onBundleComplete() {
        $buildSpinner.stop("Successfully built trigger code");
      },
    },
  });

  logger.debug("Successfully built project to", destination.path);

  logger.info("Project is", resolvedConfig.project);

  // Resolve registry and repository from options, env vars, or defaults
  const registry = options.registry ?? envVars.TRIGGER_REGISTRY ?? "localhost:5001";
  const repository = options.repository ?? envVars.TRIGGER_REPOSITORY ?? `trigger/${resolvedConfig.project}`;

  // Simulate a deployment version
  const simulatedVersion = `build-${buildManifest.contentHash.substring(0, 8)}`;
  
  // Construct imageTag with configurable registry and repository
  const imageTag = `${registry}/${repository}:${buildManifest.contentHash.substring(0, 8)}`;

  logger.debug("Using registry", { registry, repository, imageTag });

  const $imageSpinner = spinner();
  $imageSpinner.start("Building Docker image");

  const buildResult = await buildImage({
    isLocalBuild: true,
    imagePlatform: "linux/amd64",
    noCache: options.noCache,
    push: options.push,
    deploymentId: "offline",
    deploymentVersion: simulatedVersion,
    imageTag,
    load: options.load,
    contentHash: buildManifest.contentHash,
    compilationPath: destination.path,
    projectId: resolvedConfig.project,
    projectRef: resolvedConfig.project,
    apiUrl: options.apiUrl ?? "https://api.trigger.dev",
    apiKey: "offline-build",
    branchName: branch,
    authAccessToken: "",
    buildEnvVars: buildManifest.build.env,
    indexEnvVars: {}, // No server env vars in build-only mode
    network: options.network,
    builder: options.builder,
  });

  // Check for indexing results in build-only mode
  const dockerExportPath = join(destination.path, "docker-export");
  const indexMetadataPath = join(dockerExportPath, "index-metadata.json");
  const indexErrorPath = join(dockerExportPath, "index-error.json");

  // Check if there was an indexing error
  if (await pathExists(indexErrorPath)) {
    const indexError = await readJSONFile(indexErrorPath);
    $imageSpinner.stop("Failed to build image");
    throw new Error(`Indexing failed: ${JSON.stringify(indexError.error)}`);
  }

  // Check for index metadata - this is required
  if (!(await pathExists(indexMetadataPath))) {
    $imageSpinner.stop("Failed to build image");
    throw new Error("index-metadata.json not found - the Docker build did not produce required indexing output");
  }

  const indexMetadata = await readJSONFile(indexMetadataPath);
  const taskCount = indexMetadata.tasks?.length || 0;
  log.success(`Indexed ${taskCount} task${taskCount === 1 ? "" : "s"}`);

  // Save all necessary data for registerOnlyDeploy
  const deployData = {
    environment: options.env,
    branch,
    contentHash: buildManifest.contentHash,
    imageTag,
    imageDigest: (buildResult as unknown as { digest?: string }).digest,
    runtime: buildManifest.runtime,
    taskCount,
    gitMeta,
    buildManifest: {
      contentHash: buildManifest.contentHash,
      packageVersion: buildManifest.packageVersion,
      cliPackageVersion: buildManifest.cliPackageVersion,
      features: (buildManifest as unknown as any).features,
      deploy: buildManifest.deploy,
    },
    indexMetadata,
    simulatedVersion,
    buildPath: destination.path,
  };

  await writeJSONFile(join(projectPath, ".triggerdeploy.json"), deployData, true);

  if (!buildResult.ok) {
    $imageSpinner.stop("Failed to build image");
    throw new Error(buildResult.error);
  }

  $imageSpinner.stop("Successfully built image");

  if (options.saveLogs) {
    const logPath = await saveLogs(simulatedVersion, buildResult.logs);
    console.log(`Full build logs have been saved to ${logPath}`);
  }

  log.message("Build artifacts saved");

  outro(
    `Image ${imageTag} built${buildResult.digest ? " and pushed" : ""}. Run \`trigger.dev deploy --register-only\` to register it.`
  );
}

async function registerOnlyDeploy(projectPath: string, dir: string, options: DeployCommandOptions) {
  intro(`Registering deployment${options.skipPromotion ? " (without promotion)" : ""}`);
  
  if (!options.skipUpdateCheck) {
    await updateTriggerPackages(dir, { ...options }, true, true);
  }

  const authorization = await login({
    embedded: true,
    defaultApiUrl: options.apiUrl,
    profile: options.profile,
  });

  if (!authorization.ok) {
    if (authorization.error === "fetch failed") {
      throw new Error(
        `Failed to connect to ${authorization.auth?.apiUrl}. Are you sure it's the correct URL?`
      );
    } else {
      throw new Error(
        `You must login first. Use the \`login\` CLI command.\n\n${authorization.error}`
      );
    }
  }

  if (options.env === "production") {
    options.env = "prod";
  }

  const envVars = resolveLocalEnvVars(options.envFile);

  const resolvedConfig = await loadConfig({
    cwd: projectPath,
    overrides: { project: options.projectRef ?? envVars.TRIGGER_PROJECT_REF },
    configFile: options.config,
  });

  const manifestPath = join(projectPath, ".triggerdeploy.json");
  if (!(await pathExists(manifestPath))) {
    throw new Error("No build information found. Run deploy --build-only first.");
  }

  const deployData = await readJSONFile(manifestPath);
  
  // Override environment if specified
  if (options.env && options.env !== deployData.environment) {
    logger.warn(`Overriding environment from ${deployData.environment} to ${options.env}`);
    deployData.environment = options.env;
  }

  const gitMeta = deployData.gitMeta;
  const branch = deployData.branch;

  // Handle preview branch logic
  if (deployData.environment === "preview" && branch) {
    if (gitMeta?.pullRequestState === "merged" || gitMeta?.pullRequestState === "closed") {
      log.message(`Pull request ${gitMeta?.pullRequestNumber} is ${gitMeta?.pullRequestState}.`);
      const $buildSpinner = spinner();
      $buildSpinner.start(`Archiving preview branch: "${branch}"`);
      const result = await archivePreviewBranch(authorization, branch, resolvedConfig.project);
      $buildSpinner.stop(
        result ? `Successfully archived "${branch}"` : `Failed to archive "${branch}".`
      );
      return;
    }

    logger.debug("Upserting branch", { env: deployData.environment, branch });
    const branchEnv = await upsertBranch({
      accessToken: authorization.auth.accessToken,
      apiUrl: authorization.auth.apiUrl,
      projectRef: resolvedConfig.project,
      branch,
      gitMeta,
    });

    logger.debug("Upserted branch env", branchEnv);

    log.success(`Using preview branch "${branch}"`);

    if (!branchEnv) {
      throw new Error(`Failed to create branch "${branch}"`);
    }
  }

  const projectClient = await getProjectClient({
    accessToken: authorization.auth.accessToken,
    apiUrl: authorization.auth.apiUrl,
    projectRef: resolvedConfig.project,
    env: deployData.environment,
    branch,
    profile: options.profile,
  });

  if (!projectClient) {
    throw new Error("Failed to get project client");
  }

  const deploymentResponse = await projectClient.client.initializeDeployment({
    contentHash: deployData.contentHash,
    userId: authorization.userId,
    gitMeta,
    type: deployData.buildManifest.features?.run_engine_v2 ? "MANAGED" : "V1",
    runtime: deployData.runtime,
  });

  if (!deploymentResponse.success) {
    throw new Error(`Failed to start deployment: ${deploymentResponse.error}`);
  }

  const deployment = deploymentResponse.data;
  const version = deployment.version;

  // TODO: Implement automatic image retagging
  // Example ECR implementation:
  // const sourceTag = deployData.imageTag; // e.g., localhost:5001/trigger/proj_abc:0f7d1460
  // const targetTag = deployment.imageTag; // e.g., localhost:5001/trigger/proj_abc:20250725.10.prod
  // 
  // // For ECR:
  // const manifest = await x("aws", ["ecr", "batch-get-image", 
  //   "--repository-name", "trigger/proj_abc",
  //   "--image-ids", "imageTag=0f7d1460",
  //   "--output", "text",
  //   "--query", "images[].imageManifest"
  // ]);
  // await x("aws", ["ecr", "put-image",
  //   "--repository-name", "trigger/proj_abc", 
  //   "--image-tag", "20250725.10.prod",
  //   "--image-manifest", manifest.stdout
  // ]);

  // Log retagging command for manual execution
  if (deployData.imageTag && deployment.imageTag && deployData.imageTag !== deployment.imageTag) {
    const sourceTag = deployData.imageTag.split(':').pop();
    const targetTag = deployment.imageTag.split(':').pop();
    const [registry, repoPath] = deployData.imageTag.split('/').slice(0, -1).join('/').split('/');
    const repository = deployData.imageTag.split(':')[0].split('/').slice(-2).join('/');
    
    logger.info(`\nImage needs retagging from ${sourceTag} to ${targetTag}`);
    logger.info(`Run this command to retag:\n`);
    
    if (deployData.imageTag.includes('.ecr.') && deployData.imageTag.includes('.amazonaws.com')) {
      // ECR retagging command
      logger.info(`MANIFEST=$(aws ecr batch-get-image --repository-name ${repository} --image-ids imageTag=${sourceTag} --output text --query 'images[].imageManifest')`);
      logger.info(`aws ecr put-image --repository-name ${repository} --image-tag ${targetTag} --image-manifest "$MANIFEST"\n`);
    } else {
      // Local/Docker registry retagging
      logger.info(`docker tag ${deployData.imageTag} ${deployment.imageTag}`);
      logger.info(`docker push ${deployment.imageTag}\n`);
    }
    
    // Wait 5 seconds to give user time to see the command
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  const rawDeploymentLink = `${authorization.dashboardUrl}/projects/v3/${resolvedConfig.project}/deployments/${deployment.shortCode}`;
  const rawTestLink = `${authorization.dashboardUrl}/projects/v3/${
    resolvedConfig.project
  }/test?environment=${deployData.environment === "prod" ? "prod" : "stg"}`;

  const deploymentLink = cliLink("View deployment", rawDeploymentLink);
  const testLink = cliLink("Test tasks", rawTestLink);

  const $spinner = spinner();

  // Handle environment variable syncing
  const hasVarsToSync =
    Object.keys(deployData.buildManifest.deploy?.sync?.env || {}).length > 0 ||
    (branch && Object.keys(deployData.buildManifest.deploy?.sync?.parentEnv || {}).length > 0);

  if (hasVarsToSync) {
    const childVars = deployData.buildManifest.deploy?.sync?.env ?? {};
    const parentVars = deployData.buildManifest.deploy?.sync?.parentEnv ?? {};

    const numberOfEnvVars = Object.keys(childVars).length + Object.keys(parentVars).length;
    const vars = numberOfEnvVars === 1 ? "var" : "vars";

    if (!options.skipSyncEnvVars) {
      $spinner.start(`Syncing ${numberOfEnvVars} env ${vars} with the server`);

      const uploadResult = await syncEnvVarsWithServer(
        projectClient.client,
        resolvedConfig.project,
        deployData.environment,
        childVars,
        parentVars
      );

      if (!uploadResult.success) {
        await failDeploy(
          projectClient.client,
          deployment,
          {
            name: "SyncEnvVarsError",
            message: `Failed to sync ${numberOfEnvVars} env ${vars} with the server: ${uploadResult.error}`,
          },
          "",
          $spinner
        );
        throw new SkipLoggingError("Failed to sync environment variables");
      } else {
        $spinner.stop(`Successfully synced ${numberOfEnvVars} env ${vars} with the server`);
      }
    } else {
      logger.log(
        "Skipping syncing env vars. The environment variables in your project have changed, but the --skip-sync-env-vars flag was provided."
      );
    }
  }

  // Create background worker if we have index metadata
  if (deployData.indexMetadata) {
    const backgroundWorkerBody: CreateBackgroundWorkerRequestBody = {
      localOnly: true,
      metadata: {
        contentHash: deployData.indexMetadata.contentHash,
        packageVersion: deployData.indexMetadata.packageVersion,
        cliPackageVersion: deployData.indexMetadata.cliPackageVersion,
        tasks: deployData.indexMetadata.tasks,
        queues: deployData.indexMetadata.queues,
        sourceFiles: deployData.indexMetadata.sourceFiles,
        runtime: deployData.indexMetadata.runtime,
        runtimeVersion: deployData.indexMetadata.runtimeVersion,
      },
      engine: "V2",
      supportsLazyAttempts: true,
      buildPlatform: deployData.indexMetadata.buildPlatform,
      targetPlatform: deployData.indexMetadata.targetPlatform,
    };

    const createResponse = await projectClient.client.createDeploymentBackgroundWorker(
      deployment.id,
      backgroundWorkerBody
    );

    if (!createResponse.success) {
      logger.error(
        JSON.stringify({
          message: "Failed to create background worker",
          error: createResponse.error,
        })
      );
    } else {
      logger.debug(
        JSON.stringify({
          message: "Background worker created",
          createResponse: createResponse.data,
        })
      );
    }
  }

  if (isCI) {
    log.step(`Deploying version ${version}\n`);
  } else {
    if (isLinksSupported) {
      $spinner.start(`Deploying version ${version} ${deploymentLink}`);
    } else {
      $spinner.start(`Deploying version ${version}`);
    }
  }

  const finalizeResponse = await projectClient.client.finalizeDeployment(
    deployment.id,
    {
      imageDigest: deployData.imageDigest,
      skipPromotion: options.skipPromotion,
    },
    (logMessage) => {
      if (isCI) {
        console.log(logMessage);
        return;
      }

      if (isLinksSupported) {
        $spinner.message(`Deploying version ${version} ${deploymentLink}: ${logMessage}`);
      } else {
        $spinner.message(`Deploying version ${version}: ${logMessage}`);
      }
    }
  );

  if (!finalizeResponse.success) {
    await failDeploy(
      projectClient.client,
      deployment,
      { name: "FinalizeError", message: finalizeResponse.error },
      "",
      $spinner
    );

    throw new SkipLoggingError("Failed to finalize deployment");
  }

  if (isCI) {
    log.step(`Successfully deployed version ${version}`);
  } else {
    $spinner.stop(`Successfully deployed version ${version}`);
  }

  const taskCount = deployData.taskCount || 0;

  outro(
    `Version ${version} deployed with ${taskCount} detected task${taskCount === 1 ? "" : "s"} ${
      isLinksSupported ? `| ${deploymentLink} | ${testLink}` : ""
    }`
  );

  if (!isLinksSupported) {
    console.log("View deployment");
    console.log(rawDeploymentLink);
    console.log(); // new line
    console.log("Test tasks");
    console.log(rawTestLink);
  }

  setGithubActionsOutputAndEnvVars({
    envVars: {
      TRIGGER_DEPLOYMENT_VERSION: version,
      TRIGGER_VERSION: version,
      TRIGGER_DEPLOYMENT_SHORT_CODE: deployment.shortCode,
      TRIGGER_DEPLOYMENT_URL: `${authorization.dashboardUrl}/projects/v3/${resolvedConfig.project}/deployments/${deployment.shortCode}`,
      TRIGGER_TEST_URL: `${authorization.dashboardUrl}/projects/v3/${
        resolvedConfig.project
      }/test?environment=${deployData.environment === "prod" ? "prod" : "stg"}`,
    },
    outputs: {
      deploymentVersion: version,
      workerVersion: version,
      deploymentShortCode: deployment.shortCode,
      deploymentUrl: `${authorization.dashboardUrl}/projects/v3/${resolvedConfig.project}/deployments/${deployment.shortCode}`,
      testUrl: `${authorization.dashboardUrl}/projects/v3/${
        resolvedConfig.project
      }/test?environment=${deployData.environment === "prod" ? "prod" : "stg"}`,
      needsPromotion: options.skipPromotion ? "true" : "false",
    },
  });
}

export function verifyDirectory(dir: string, projectPath: string) {
  if (dir !== "." && !isDirectory(projectPath)) {
    if (dir === "staging" || dir === "prod" || dir === "preview") {
      throw new Error(`To deploy to ${dir}, you need to pass "--env ${dir}", not just "${dir}".`);
    }

    if (dir === "production") {
      throw new Error(`To deploy to production, you need to pass "--env prod", not "production".`);
    }

    if (dir === "stg") {
      throw new Error(`To deploy to staging, you need to pass "--env staging", not "stg".`);
    }

    throw new Error(`Directory "${dir}" not found at ${projectPath}`);
  }
}
