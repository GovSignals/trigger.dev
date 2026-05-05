// Public API surface for downstream tooling that wants to drive the
// build / deploy pipeline programmatically without going through the
// `trigger` CLI binary.
//
// Mirrors the pattern used by `@trigger.dev/build`'s `./internal` subpath:
// the modules exported here are stable enough to be consumed by adjacent
// packages, but they sit *below* the documented CLI command surface, so
// consumers should pin to a specific version of this package.

// Build / deploy primitives
export { loadConfig } from "./config.js";
export { buildWorker } from "./build/buildWorker.js";
export { buildImage } from "./deploy/buildImage.js";

// Auth + project-environment resolution. `login` reads TRIGGER_ACCESS_TOKEN
// from the env when present (so it works in CI without a config file);
// `getProjectClient` performs the two-step engine API URL discovery and
// returns an engine-bound CliApiClient that callers use for all subsequent
// deploy/register/finalize/fail API calls.
export { login } from "./commands/login.js";
export { getProjectClient } from "./utilities/session.js";

// Deploy-time env var sync (deploy.sync.env / .parentEnv -> POST .../envvars/import).
export { syncEnvVarsWithServer } from "./commands/deploy.js";

// Build-host helpers used by the deploy flow:
//   - resolveLocalEnvVars / loadDotEnvVars: read project-local .env files
//   - createGitMeta: extract git metadata for the deployment record
//   - getTmpDir: scoped temp directory with cleanup tracking
//   - setGithubActionsOutputAndEnvVars: emit deployment metadata to GHA
export { resolveLocalEnvVars } from "./utilities/localEnvVars.js";
export { loadDotEnvVars } from "./utilities/dotEnv.js";
export { createGitMeta } from "./utilities/gitMeta.js";
export { getTmpDir } from "./utilities/tempDirectories.js";
export { setGithubActionsOutputAndEnvVars } from "./utilities/githubActions.js";
