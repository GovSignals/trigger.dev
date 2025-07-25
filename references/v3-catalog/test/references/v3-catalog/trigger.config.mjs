import {
  defineConfig
} from "../../chunk-E2WZMITO.mjs";
import "../../chunk-TJGTO6YJ.mjs";
import "../../chunk-2X26PNN2.mjs";
import "../../chunk-NENC26SH.mjs";
import {
  init_esm
} from "../../chunk-CNFPS2CV.mjs";

// trigger.config.ts
init_esm();
var trigger_config_default = defineConfig({
  runtime: "node",
  project: "yubjwjsfkxnylobaqvqz",
  machine: "medium-1x",
  // instrumentations: [new OpenAIInstrumentation()],
  maxDuration: 3600,
  dirs: ["./src/trigger"],
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 10,
      minTimeoutInMs: 5e3,
      maxTimeoutInMs: 3e4,
      factor: 2,
      randomize: true
    }
  },
  enableConsoleLogging: false,
  logLevel: "info",
  build: {}
});
var resolveEnvVars = void 0;
export {
  trigger_config_default as default,
  resolveEnvVars
};
//# sourceMappingURL=trigger.config.mjs.map
