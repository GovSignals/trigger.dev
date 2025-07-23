import { intro, log, outro } from "@clack/prompts";
import { getBranch, prepareDeploymentError, tryCatch } from "@trigger.dev/core/v3";
import { InitializeDeploymentResponseBody } from "@trigger.dev/core/v3/schemas";
import { Command, Option as CommandOption } from "commander";
import { resolve } from "node:path";
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
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

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
  // Two-phase deployment options
  buildOnly: z.boolean().default(false),
  registerOnly: z.boolean().default(false),
  registry: z.string().optional(),
  namespace: z.string().optional(),
  tag: z.string().optional(),
});

type DeployCommandOptions = z.infer<typeof DeployCommandOptions>;

type Deployment = InitializeDeploymentResponseBody;

// Build manifest type for storing metadata between phases
type BuildManifestFile = {
  projectRef: string;
  environment: string;
  contentHash: string;
  imageTag: string;
  imageDigest?: string;
  timestamp: string;
  runtime?: string;
};

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
        .option(
          "--build-only",
          "Build and push the deployment image without registering it with Trigger.dev"
        )
        .option(
          "--register-only",
          "Register a previously built image with Trigger.dev without building"
        )
        .option(
          "--registry <registry>",
          "Docker registry to use for the image (e.g., registry.example.com)"
        )
        .option(
          "--namespace <namespace>",
          "Docker namespace/organization to use for the image (e.g., my-org/trigger)"
        )
        .option(
          "--tag <tag>",
          "Full image name and tag to use (overrides registry/namespace)"
        )
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
  // Check for mutually exclusive flags
  if (options.buildOnly && options.registerOnly) {
    outro(chalkError("Error: --build-only and --register-only cannot be used together."));
    throw new SkipLoggingError("Invalid flag combination");
  }

  // Route to register-only flow if specified
  if (options.registerOnly) {
    return await handleRegisterOnly(dir, options);
  }

  intro(`Deploying project${options.skipPromotion ? " (without promotion)" : ""}${options.buildOnly ? " (build only)" : ""}`);

  if (!options.skipUpdateCheck) {
    await updateTriggerPackages(dir, { ...options }, true, true);
  }

  const cwd = process.cwd();
  const projectPath = resolve(cwd, dir);

  verifyDirectory(dir, projectPath);

  // In build-only mode, we can use a minimal authorization if login fails
  let authorization: any;
  
  if (options.buildOnly) {
    try {
      authorization = await login({
        embedded: true,
        defaultApiUrl: options.apiUrl,
        profile: options.profile,
      });
    } catch (e) {
      // If login fails in build-only mode, use minimal auth
      authorization = {
        ok: true as const,
        auth: {
          accessToken: process.env.TRIGGER_ACCESS_TOKEN || "",
          apiUrl: options.apiUrl || "https://api.trigger.dev",
        },
        userId: "offline",
        dashboardUrl: "https://trigger.dev",
      };
    }
  } else {
    authorization = await login({
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

  // Skip project client in build-only mode
  let projectClient: any = null;
  let serverEnvVars: any = { success: false, data: { variables: {} } };
  
  if (!options.buildOnly) {
    projectClient = await getProjectClient({
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

    serverEnvVars = await projectClient.client.getEnvironmentVariables(resolvedConfig.project);
  }
  
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
          $buildSpinner.stop("Successfully built code");

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

  // Handle build-only mode
  if (options.buildOnly) {
    return await handleBuildOnly({
      options,
      resolvedConfig,
      buildManifest,
      destination,
      authorization,
      branch,
    });
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

// Helper function to generate image tag for build-only mode
function generateImageTag(options: {
  tag?: string;
  registry?: string;
  namespace?: string;
  projectRef: string;
  contentHash: string;
}): string {
  // If full tag is provided, use it directly
  if (options.tag) {
    return options.tag;
  }

  // Build tag from components
  const registry = options.registry || "localhost";
  const namespace = options.namespace || "trigger";
  const projectName = options.projectRef.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
  const shortHash = options.contentHash.substring(0, 8);
  
  return `${registry}/${namespace}/${projectName}:trigger-${shortHash}`;
}

// Get manifest file path for the environment
function getManifestPath(projectPath: string, env: string): string {
  return join(projectPath, `.triggerdeploy.${env}.json`);
}

// Handle build-only mode
async function handleBuildOnly(params: {
  options: DeployCommandOptions;
  resolvedConfig: any;
  buildManifest: any;
  destination: any;
  authorization: any;
  branch?: string;
}) {
  const { options, resolvedConfig, buildManifest, destination, authorization, branch } = params;

  // Generate or use provided image tag
  const imageTag = generateImageTag({
    tag: options.tag,
    registry: options.registry,
    namespace: options.namespace,
    projectRef: resolvedConfig.project,
    contentHash: buildManifest.contentHash,
  });

  logger.debug("Using image tag for build-only mode", { imageTag });

  const $spinner = spinner();
  $spinner.start(`Building image ${imageTag} (local build)`);

  // Build the Docker image
  const buildResult = await buildImage({
    isLocalBuild: true,
    noCache: options.noCache,
    // Use placeholder values for required fields
    deploymentId: "offline",
    deploymentVersion: "offline",
    imageTag,
    imagePlatform: "linux/amd64", // Default platform
    load: options.load,
    contentHash: buildManifest.contentHash,
    projectId: resolvedConfig.project,
    projectRef: resolvedConfig.project,
    apiUrl: authorization.auth.apiUrl,
    apiKey: authorization.auth.accessToken || process.env.TRIGGER_ACCESS_TOKEN || "",
    branchName: branch,
    authAccessToken: authorization.auth.accessToken,
    compilationPath: destination.path,
    buildEnvVars: buildManifest.build.env,
    // Local build options
    network: options.network,
    builder: options.builder,
    push: options.push ?? true, // Default to push unless explicitly disabled
    onLog: (logMessage) => {
      $spinner.message(`Building image: ${logMessage}`);
    },
  });

  if (!buildResult.ok) {
    $spinner.stop("Failed to build image");
    throw new SkipLoggingError(`Failed to build image: ${buildResult.error}`);
  }

  $spinner.stop(`Successfully built and pushed image ${imageTag}`);

  // Save manifest for Phase 2
  const manifest: BuildManifestFile = {
    projectRef: resolvedConfig.project,
    environment: options.env,
    contentHash: buildManifest.contentHash,
    imageTag,
    imageDigest: buildResult.digest,
    timestamp: new Date().toISOString(),
    runtime: buildManifest.runtime,
  };

  const manifestPath = getManifestPath(resolvedConfig.workingDir, options.env);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  logger.debug("Saved build manifest", { path: manifestPath, manifest });

  // Note: Task information is not available at build time - tasks are discovered during container startup

  outro(
    `Version built and pushed to ${imageTag}\n\n` +
    `To register this deployment, run:\n` +
    `  trigger.dev deploy --register-only${options.env !== "prod" ? ` --env ${options.env}` : ""}\n\n` +
    `(Ensure you have access to the Trigger.dev API)`
  );

  if (options.saveLogs) {
    const logPath = await saveLogs(`build-${buildManifest.contentHash.substring(0, 8)}`, buildResult.logs);
    console.log(`Full build logs have been saved to ${logPath}`);
  }
}

// Handle register-only mode
async function handleRegisterOnly(dir: string, options: DeployCommandOptions) {
  intro(`Registering deployment${options.skipPromotion ? " (without promotion)" : ""}`);

  const cwd = process.cwd();
  const projectPath = resolve(cwd, dir);

  verifyDirectory(dir, projectPath);

  // Load config
  const envVars = resolveLocalEnvVars(options.envFile);
  const resolvedConfig = await loadConfig({
    cwd: projectPath,
    overrides: { project: options.projectRef ?? envVars.TRIGGER_PROJECT_REF },
    configFile: options.config,
  });

  // Read manifest from Phase 1
  const manifestPath = getManifestPath(resolvedConfig.workingDir, options.env);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `No deployment manifest found at ${manifestPath}.\n` +
      `Please run 'deploy --build-only' first or ensure you're in the correct directory.`
    );
  }

  const manifest: BuildManifestFile = JSON.parse(readFileSync(manifestPath, 'utf8'));
  logger.debug("Loaded build manifest", { manifest });

  // Verify environment matches
  if (manifest.environment !== options.env) {
    throw new Error(
      `Manifest environment (${manifest.environment}) does not match specified environment (${options.env}).\n` +
      `The manifest was created for ${manifest.environment}, but you're trying to register to ${options.env}.`
    );
  }

  // Login and get project client
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

  const gitMeta = await createGitMeta(resolvedConfig.workspaceDir);
  const branch = options.env === "preview" ? getBranch({ specified: options.branch, gitMeta }) : undefined;

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

  const $spinner = spinner();
  $spinner.start("Initializing deployment with Trigger.dev");

  // Initialize deployment with the API
  const deploymentResponse = await projectClient.client.initializeDeployment({
    contentHash: manifest.contentHash,
    userId: authorization.userId,
    gitMeta,
    type: "UNMANAGED", // Signal that this is a self-hosted/unmanaged deployment
    runtime: manifest.runtime || "node", // Use runtime from manifest or default to node
  });

  if (!deploymentResponse.success) {
    $spinner.stop("Failed to initialize deployment");
    throw new Error(`Failed to initialize deployment: ${deploymentResponse.error}`);
  }

  const deployment = deploymentResponse.data;
  const version = deployment.version;

  $spinner.message(`Initialized deployment version ${version}`);

  // Check if the server's expected image tag matches what we built
  const serverImageRepo = deployment.imageTag.substring(0, deployment.imageTag.lastIndexOf(':'));
  const manifestImageRepo = manifest.imageTag.substring(0, manifest.imageTag.lastIndexOf(':'));
  
  if (serverImageRepo !== manifestImageRepo) {
    logger.warn("Image repository mismatch", {
      server: serverImageRepo,
      manifest: manifestImageRepo
    });
    $spinner.stop("Warning: Image repository mismatch");
    log.warning(
      `The server expects the image at '${serverImageRepo}' but it was pushed to '${manifestImageRepo}'.\n` +
      `The deployment may fail if the server cannot access the image.`
    );
  }

  const rawDeploymentLink = `${authorization.dashboardUrl}/projects/v3/${resolvedConfig.project}/deployments/${deployment.shortCode}`;
  const deploymentLink = cliLink("View deployment", rawDeploymentLink);

  if (isLinksSupported) {
    $spinner.message(`Registering deployment version ${version} ${deploymentLink}`);
  } else {
    $spinner.message(`Registering deployment version ${version}`);
  }

  // Finalize the deployment with the image digest
  const finalizeResponse = await projectClient.client.finalizeDeployment(
    deployment.id,
    {
      imageDigest: manifest.imageDigest,
      skipPromotion: options.skipPromotion,
    },
    (logMessage) => {
      if (isLinksSupported) {
        $spinner.message(`Finalizing deployment version ${version} ${deploymentLink}: ${logMessage}`);
      } else {
        $spinner.message(`Finalizing deployment version ${version}: ${logMessage}`);
      }
    }
  );

  if (!finalizeResponse.success) {
    $spinner.stop("Failed to finalize deployment");
    throw new Error(`Failed to finalize deployment: ${finalizeResponse.error}`);
  }

  $spinner.stop(`Successfully registered deployment version ${version}`);

  // Get deployment details to show task count
  const getDeploymentResponse = await projectClient.client.getDeployment(deployment.id);
  
  let taskCount = 0;
  if (getDeploymentResponse.success && getDeploymentResponse.data.worker) {
    taskCount = getDeploymentResponse.data.worker.tasks.length;
  }

  const rawTestLink = `${authorization.dashboardUrl}/projects/v3/${
    resolvedConfig.project
  }/test?environment=${options.env === "prod" ? "prod" : "stg"}`;
  const testLink = cliLink("Test tasks", rawTestLink);

  outro(
    `Deployment version ${version} has been registered successfully${
      options.skipPromotion ? " (not promoted to current yet)" : ""
    }.\n` +
    `${taskCount > 0 ? `${taskCount} task${taskCount === 1 ? "" : "s"} detected | ` : ""}` +
    `${isLinksSupported ? `${deploymentLink} | ${testLink}` : ""}`
  );

  if (!isLinksSupported) {
    console.log("View deployment");
    console.log(rawDeploymentLink);
    console.log(); // new line
    console.log("Test tasks");
    console.log(rawTestLink);
  }

  if (options.skipPromotion) {
    log.message(
      `To promote this deployment to current, run:\n` +
      `  trigger.dev promote ${version}`
    );
  }

  setGithubActionsOutputAndEnvVars({
    envVars: {
      TRIGGER_DEPLOYMENT_VERSION: version,
      TRIGGER_VERSION: version,
      TRIGGER_DEPLOYMENT_SHORT_CODE: deployment.shortCode,
      TRIGGER_DEPLOYMENT_URL: rawDeploymentLink,
      TRIGGER_TEST_URL: rawTestLink,
    },
    outputs: {
      deploymentVersion: version,
      workerVersion: version,
      deploymentShortCode: deployment.shortCode,
      deploymentUrl: rawDeploymentLink,
      testUrl: rawTestLink,
      needsPromotion: options.skipPromotion ? "true" : "false",
    },
  });
}
