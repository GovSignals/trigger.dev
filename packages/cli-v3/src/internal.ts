// Public API surface for downstream tooling that wants to drive the
// build / deploy pipeline programmatically without going through the
// `trigger` CLI binary.
//
// Mirrors the pattern used by `@trigger.dev/build`'s `./internal` subpath:
// the modules exported here are stable enough to be consumed by adjacent
// packages, but they sit *below* the documented CLI command surface, so
// consumers should pin to a specific version of this package.

export { loadConfig } from "./config.js";
export { buildWorker } from "./build/buildWorker.js";
export { buildImage } from "./deploy/buildImage.js";
