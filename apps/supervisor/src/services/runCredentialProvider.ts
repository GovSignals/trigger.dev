import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import { z } from "zod";
import { Counter } from "prom-client";
import { env } from "../env.js";
import { register } from "../metrics.js";

const logger = new SimpleStructuredLogger("run-credential-provider");

/**
 * True when a per-run credential provider is configured. When enabled, every run
 * is treated as credential-bound: the supervisor mints run-scoped credentials at
 * pod creation and (because those credentials are baked into the pod's static
 * env) the run must NOT warm-start or restore from a checkpoint — a reused pod
 * would carry another run's credentials. See index.ts for the warm-start guard.
 */
export const runCredentialProviderEnabled = Boolean(env.RUN_CREDENTIAL_PROVIDER_URL);

/**
 * The run context the supervisor forwards to the provider. This is deliberately
 * limited to what the supervisor reliably has from the dequeued message — it does
 * NOT include the task payload or run metadata (those never reach the
 * supervisor). A provider maps these identifiers/claims to a scoped credential;
 * any application-level tenant mapping (e.g. Trigger project/env -> customer org)
 * happens inside the provider, keeping this mechanism tenant-agnostic.
 */
export interface RunCredentialContext {
  runId: string;
  runFriendlyId: string;
  isTest: boolean;
  isReplay: boolean;
  orgId: string;
  projectId: string;
  envId: string;
  envType: string;
  deploymentFriendlyId: string;
  deploymentVersion: string;
  annotations?: Record<string, unknown>;
}

const RunCredentialResponse = z.object({
  /** Env vars injected into the single worker pod/container for this run. */
  env: z.record(z.string(), z.string()),
  /**
   * Whether this credential binds the pod to this one run. Defaults to true.
   * Reserved for future per-run opt-out; today the supervisor already skips
   * warm-start/restore whenever the provider is enabled.
   */
  bindsPodToRun: z.boolean().default(true),
});

export type RunCredentialResult = z.infer<typeof RunCredentialResponse>;

const mintCounter = new Counter({
  name: "run_credential_minted_total",
  help: "Per-run credentials minted and injected into the worker pod at creation",
  labelNames: ["env_type", "outcome"] as const,
  registers: [register],
});

/**
 * Mint run-scoped credentials for a single worker pod.
 *
 * - Returns the provider result (env to inject) on success.
 * - Returns `undefined` when the provider is not configured.
 * - On failure: throws when failing closed (the default), so the caller aborts
 *   pod creation and no worker starts without its scoped credential; returns
 *   `undefined` when `RUN_CREDENTIAL_PROVIDER_FAIL_OPEN` is set.
 */
export async function mintRunCredentials(
  context: RunCredentialContext
): Promise<RunCredentialResult | undefined> {
  const url = env.RUN_CREDENTIAL_PROVIDER_URL;
  if (!url) {
    return undefined;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.RUN_CREDENTIAL_PROVIDER_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (env.RUN_CREDENTIAL_PROVIDER_TOKEN) {
      headers.Authorization = `Bearer ${env.RUN_CREDENTIAL_PROVIDER_TOKEN}`;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ context }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Run credential provider returned ${res.status}`);
    }

    const parsed = RunCredentialResponse.parse(await res.json());
    mintCounter.inc({ env_type: context.envType, outcome: "success" });
    return parsed;
  } catch (error) {
    mintCounter.inc({ env_type: context.envType, outcome: "error" });

    if (env.RUN_CREDENTIAL_PROVIDER_FAIL_OPEN) {
      logger.error("Failed to mint run credentials, failing open (pod created without them)", {
        runId: context.runFriendlyId,
        error,
      });
      return undefined;
    }

    logger.error("Failed to mint run credentials, failing closed (pod will not be created)", {
      runId: context.runFriendlyId,
      error,
    });
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timeout);
  }
}
