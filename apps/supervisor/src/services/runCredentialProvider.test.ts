import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Registry } from "prom-client";
import type { RunCredentialContext } from "./runCredentialProvider.js";

// Mutable env stand-in so individual tests can flip fail-open etc. mintRunCredentials
// reads env.* at call time, so mutating between tests takes effect.
const mockEnv = {
  RUN_CREDENTIAL_PROVIDER_URL: "https://mint.example/token" as string | undefined,
  RUN_CREDENTIAL_PROVIDER_TOKEN: "supervisor-service-token" as string | undefined,
  RUN_CREDENTIAL_PROVIDER_TIMEOUT_MS: 5000,
  RUN_CREDENTIAL_PROVIDER_FAIL_OPEN: false,
};

vi.mock("../env.js", () => ({ env: mockEnv }));
// Fresh registry so the module's Counter registration doesn't collide across files.
vi.mock("../metrics.js", () => ({ register: new Registry() }));

const { mintRunCredentials } = await import("./runCredentialProvider.js");

type FetchInit = { method: string; headers: Record<string, string>; body: string };

const context: RunCredentialContext = {
  runId: "run_abc",
  runFriendlyId: "run_friendly",
  isTest: false,
  isReplay: false,
  orgId: "org_1",
  projectId: "proj_1",
  envId: "env_1",
  envType: "PRODUCTION",
  deploymentFriendlyId: "deploy_1",
  deploymentVersion: "20260101.1",
};

beforeEach(() => {
  mockEnv.RUN_CREDENTIAL_PROVIDER_URL = "https://mint.example/token";
  mockEnv.RUN_CREDENTIAL_PROVIDER_TOKEN = "supervisor-service-token";
  mockEnv.RUN_CREDENTIAL_PROVIDER_FAIL_OPEN = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mintRunCredentials", () => {
  it("returns undefined when no provider is configured", async () => {
    mockEnv.RUN_CREDENTIAL_PROVIDER_URL = undefined;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(mintRunCredentials(context)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs the run context with the supervisor bearer token and returns the minted env", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: FetchInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ env: { SILKLINE_ORG_JWT: "jwt-value" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await mintRunCredentials(context);

    expect(result).toEqual({ env: { SILKLINE_ORG_JWT: "jwt-value" }, bindsPodToRun: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://mint.example/token");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer supervisor-service-token");
    expect(JSON.parse(init.body)).toEqual({ context });
  });

  it("omits the Authorization header when no provider token is set", async () => {
    mockEnv.RUN_CREDENTIAL_PROVIDER_TOKEN = undefined;
    const fetchMock = vi.fn(async (_url: string, _init: FetchInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ env: {} }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await mintRunCredentials(context);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("fails closed by default: throws on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    );

    await expect(mintRunCredentials(context)).rejects.toThrow(/500/);
  });

  it("fails closed by default: throws on a malformed response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ notEnv: true }) }))
    );

    await expect(mintRunCredentials(context)).rejects.toThrow();
  });

  it("fails open when configured: returns undefined instead of throwing", async () => {
    mockEnv.RUN_CREDENTIAL_PROVIDER_FAIL_OPEN = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }))
    );

    await expect(mintRunCredentials(context)).resolves.toBeUndefined();
  });
});
