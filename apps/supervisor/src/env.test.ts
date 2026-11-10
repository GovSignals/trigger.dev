import { describe, it, expect, vi } from "vitest";

// Mock std-env before importing env.ts so the module-level `Env.parse(stdEnv)`
// doesn't fail in a test environment that lacks required vars.
vi.mock("std-env", () => ({
  env: {
    TRIGGER_API_URL: "http://localhost:3030",
    TRIGGER_WORKER_TOKEN: "test-token",
    MANAGED_WORKER_SECRET: "test-secret",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  },
}));

const { Env } = await import("./env.js");

// Minimal env that satisfies all required fields; everything else has defaults.
const base = {
  TRIGGER_API_URL: "http://localhost:3030",
  TRIGGER_WORKER_TOKEN: "test-token",
  MANAGED_WORKER_SECRET: "test-secret",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
};

describe("Env superRefine - backpressure source awareness", () => {
  it("pod-count source can be enabled without a Redis host", () => {
    expect(() =>
      Env.parse({
        ...base,
        TRIGGER_DEQUEUE_BACKPRESSURE_POD_COUNT_ENABLED: "true",
      })
    ).not.toThrow();
  });

  it("redis source requires a Redis host", () => {
    expect(() =>
      Env.parse({
        ...base,
        TRIGGER_DEQUEUE_BACKPRESSURE_ENABLED: "true",
      })
    ).toThrow();
  });

  it("both sources can be enabled together (with a Redis host)", () => {
    expect(() =>
      Env.parse({
        ...base,
        TRIGGER_DEQUEUE_BACKPRESSURE_ENABLED: "true",
        TRIGGER_DEQUEUE_BACKPRESSURE_REDIS_HOST: "localhost",
        TRIGGER_DEQUEUE_BACKPRESSURE_POD_COUNT_ENABLED: "true",
      })
    ).not.toThrow();
  });

  it("rejects pod-count release >= engage when the source is enabled", () => {
    expect(() =>
      Env.parse({
        ...base,
        TRIGGER_DEQUEUE_BACKPRESSURE_POD_COUNT_ENABLED: "true",
        TRIGGER_DEQUEUE_BACKPRESSURE_POD_COUNT_ENGAGE: "100",
        TRIGGER_DEQUEUE_BACKPRESSURE_POD_COUNT_RELEASE: "100",
      })
    ).toThrow();
  });
});

describe("Env superRefine - worker volumes", () => {
  const volumes = JSON.stringify([{ name: "extra-ca", configMap: { name: "my-ca-bundle" } }]);
  const mounts = JSON.stringify([
    { name: "extra-ca", mountPath: "/etc/ssl/extra-ca", readOnly: true },
  ]);

  const issueMessages = (input: Record<string, string>) => {
    const result = Env.safeParse({ ...base, ...input });
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  };

  it("defaults both lists to empty", () => {
    const parsed = Env.parse(base);
    expect(parsed.KUBERNETES_WORKER_VOLUMES).toEqual([]);
    expect(parsed.KUBERNETES_WORKER_VOLUME_MOUNTS).toEqual([]);
  });

  it("accepts mounts that name a configured volume", () => {
    const parsed = Env.parse({
      ...base,
      KUBERNETES_WORKER_VOLUMES: volumes,
      KUBERNETES_WORKER_VOLUME_MOUNTS: mounts,
    });
    expect(parsed.KUBERNETES_WORKER_VOLUMES).toEqual(JSON.parse(volumes));
    expect(parsed.KUBERNETES_WORKER_VOLUME_MOUNTS).toEqual(JSON.parse(mounts));
  });

  it("refuses to start when a mount names a volume that is not configured", () => {
    expect(issueMessages({ KUBERNETES_WORKER_VOLUME_MOUNTS: mounts })).toEqual([
      'KUBERNETES_WORKER_VOLUME_MOUNTS mounts volume "extra-ca", which is not defined in KUBERNETES_WORKER_VOLUMES',
    ]);
  });

  it("refuses to start when two volumes share a name", () => {
    const duplicated = JSON.stringify([
      { name: "extra-ca", configMap: { name: "a" } },
      { name: "extra-ca", configMap: { name: "b" } },
    ]);
    expect(issueMessages({ KUBERNETES_WORKER_VOLUMES: duplicated })).toEqual([
      'KUBERNETES_WORKER_VOLUMES has more than one volume named "extra-ca"',
    ]);
  });

  it("refuses to start when a mount has no mountPath, reporting only the parse error", () => {
    const messages = issueMessages({
      KUBERNETES_WORKER_VOLUMES: volumes,
      KUBERNETES_WORKER_VOLUME_MOUNTS: '[{"name":"extra-ca"}]',
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/^KUBERNETES_WORKER_VOLUME_MOUNTS has invalid item/);
  });
});
