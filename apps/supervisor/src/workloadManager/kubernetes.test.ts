import { describe, expect, it } from "vitest";
import {
  BLOCK_IO_URING_SECCOMP_PROFILE,
  findWorkerVolumeConfigErrors,
  withBlockIoUringSeccompProfile,
  withWorkerVolumeMounts,
  withWorkerVolumes,
  WorkerVolumeMountSchema,
  WorkerVolumeSchema,
} from "./kubernetesPodSpec.js";

const basePodSpec = {
  restartPolicy: "Never" as const,
  automountServiceAccountToken: false,
  securityContext: {
    runAsNonRoot: true,
    runAsUser: 1000,
    fsGroup: 1000,
  },
};

describe("withBlockIoUringSeccompProfile", () => {
  it("adds the Localhost io_uring profile for node-24 and above, preserving pod security defaults", () => {
    for (const runtime of ["node-24", "node-26", "node-30", "experimental-node-24"]) {
      const podSpec = withBlockIoUringSeccompProfile(basePodSpec, runtime);

      expect(podSpec).toMatchObject({
        ...basePodSpec,
        securityContext: {
          ...basePodSpec.securityContext,
          seccompProfile: {
            type: "Localhost",
            localhostProfile: BLOCK_IO_URING_SECCOMP_PROFILE,
          },
        },
      });
    }
  });

  it("leaves the pod spec unchanged for runtimes that do not create io_uring fds", () => {
    for (const runtime of ["node", "node-22", "bun", undefined, null, ""]) {
      expect(withBlockIoUringSeccompProfile(basePodSpec, runtime)).toEqual(basePodSpec);
    }
  });
});

const caVolume = { name: "extra-ca", configMap: { name: "my-ca-bundle" } };
const caMount = { name: "extra-ca", mountPath: "/etc/ssl/extra-ca", readOnly: true };

describe("withWorkerVolumes", () => {
  it("leaves the pod spec exactly as it was when no volumes are configured", () => {
    const podSpec = withWorkerVolumes(basePodSpec, []);

    expect(podSpec).toBe(basePodSpec);
    expect(podSpec).not.toHaveProperty("volumes");
  });

  it("adds the configured volumes to a pod spec that has none", () => {
    expect(withWorkerVolumes(basePodSpec, [caVolume])).toEqual({
      ...basePodSpec,
      volumes: [caVolume],
    });
  });

  it("appends to volumes already on the pod spec instead of replacing them", () => {
    const existing = { name: "scratch", emptyDir: {} };
    const podSpec = { ...basePodSpec, volumes: [existing] };

    expect(withWorkerVolumes(podSpec, [caVolume]).volumes).toEqual([existing, caVolume]);
    expect(podSpec.volumes).toEqual([existing]);
  });
});

describe("withWorkerVolumeMounts", () => {
  const runController = { name: "run-controller", image: "task:latest" };
  const sidecar = { name: "sidecar", image: "sidecar:latest" };

  it("leaves the containers exactly as they were when no mounts are configured", () => {
    const containers = [runController];
    const result = withWorkerVolumeMounts([], containers);

    expect(result).toBe(containers);
    expect(result[0]).not.toHaveProperty("volumeMounts");
  });

  it("adds the configured mounts to the run-controller container", () => {
    expect(withWorkerVolumeMounts([caMount], [runController])).toEqual([
      { ...runController, volumeMounts: [caMount] },
    ]);
  });

  it("appends to mounts already on the container instead of replacing them", () => {
    const existing = { name: "scratch", mountPath: "/scratch" };
    const withExisting = { ...runController, volumeMounts: [existing] };

    expect(withWorkerVolumeMounts([caMount], [withExisting])[0]?.volumeMounts).toEqual([
      existing,
      caMount,
    ]);
    expect(withExisting.volumeMounts).toEqual([existing]);
  });

  it("does not mount into containers other than run-controller", () => {
    expect(withWorkerVolumeMounts([caMount], [sidecar, runController])).toEqual([
      sidecar,
      { ...runController, volumeMounts: [caMount] },
    ]);
  });
});

describe("findWorkerVolumeConfigErrors", () => {
  it("accepts empty lists", () => {
    expect(findWorkerVolumeConfigErrors([], [])).toEqual([]);
  });

  it("accepts mounts that all name a configured volume, and volumes with no mount", () => {
    expect(
      findWorkerVolumeConfigErrors([caVolume, { name: "unused", emptyDir: {} }], [caMount])
    ).toEqual([]);
  });

  it("reports a mount naming a volume that is not configured, naming the env var", () => {
    expect(findWorkerVolumeConfigErrors([], [caMount])).toEqual([
      {
        envVar: "KUBERNETES_WORKER_VOLUME_MOUNTS",
        message:
          'KUBERNETES_WORKER_VOLUME_MOUNTS mounts volume "extra-ca", which is not defined in KUBERNETES_WORKER_VOLUMES',
      },
    ]);
  });

  it("reports two mounts at the same path once, naming the env var", () => {
    const other = { name: "other", emptyDir: {} };
    const clash = { name: "other", mountPath: caMount.mountPath };
    expect(findWorkerVolumeConfigErrors([caVolume, other], [caMount, clash, { ...clash }])).toEqual(
      [
        {
          envVar: "KUBERNETES_WORKER_VOLUME_MOUNTS",
          message:
            'KUBERNETES_WORKER_VOLUME_MOUNTS has more than one mount at path "/etc/ssl/extra-ca"',
        },
      ]
    );
  });

  it("accepts two mounts of the same volume at different paths", () => {
    expect(
      findWorkerVolumeConfigErrors(
        [caVolume],
        [caMount, { name: "extra-ca", mountPath: "/etc/ssl/certs/extra" }]
      )
    ).toEqual([]);
  });

  it("reports two volumes sharing a name once, naming the env var", () => {
    expect(findWorkerVolumeConfigErrors([caVolume, caVolume, caVolume], [caMount])).toEqual([
      {
        envVar: "KUBERNETES_WORKER_VOLUMES",
        message: 'KUBERNETES_WORKER_VOLUMES has more than one volume named "extra-ca"',
      },
    ]);
  });
});

const issueMessages = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.success ? [] : (result.error?.issues.map((issue) => issue.message) ?? []);

describe("WorkerVolumeSchema", () => {
  it("accepts a volume with one known source", () => {
    expect(WorkerVolumeSchema.parse(caVolume)).toEqual(caVolume);
    expect(WorkerVolumeSchema.parse({ name: "scratch", emptyDir: {} })).toEqual({
      name: "scratch",
      emptyDir: {},
    });
  });

  it.each([
    ["projected", { sources: [{ configMap: { name: "my-ca-bundle" } }] }],
    ["csi", { driver: "secrets-store.csi.k8s.io" }],
    ["ephemeral", { volumeClaimTemplate: { spec: {} } }],
    ["downwardAPI", { items: [] }],
    ["secret", { secretName: "my-secret" }],
  ])("accepts a %s volume source", (source, value) => {
    const volume = { name: "extra", [source]: value };
    expect(WorkerVolumeSchema.parse(volume)).toEqual(volume);
  });

  it("rejects an unknown top-level key such as a lowercase configmap, naming the key", () => {
    expect(
      issueMessages(
        WorkerVolumeSchema.safeParse({ name: "extra-ca", configmap: { name: "my-ca-bundle" } })
      )
    ).toEqual([
      'unknown key "configmap" (not a V1Volume field)',
      'volume "extra-ca" must have exactly one volume source (got none)',
    ]);
  });

  it("rejects a volume with no source", () => {
    expect(issueMessages(WorkerVolumeSchema.safeParse({ name: "extra-ca" }))).toEqual([
      'volume "extra-ca" must have exactly one volume source (got none)',
    ]);
  });

  it("rejects a volume with two sources", () => {
    expect(
      issueMessages(
        WorkerVolumeSchema.safeParse({
          name: "extra-ca",
          configMap: { name: "my-ca-bundle" },
          secret: { secretName: "my-ca-secret" },
        })
      )
    ).toEqual(['volume "extra-ca" must have exactly one volume source (got configMap, secret)']);
  });

  it("rejects a source whose value is not a JSON object", () => {
    for (const value of ["my-ca-bundle", 1, true, null, [{ name: "my-ca-bundle" }]]) {
      expect(
        issueMessages(WorkerVolumeSchema.safeParse({ name: "extra-ca", configMap: value }))
      ).toEqual(['volume source "configMap" must be a JSON object']);
    }
  });
});

describe("WorkerVolumeMountSchema", () => {
  it("accepts a mount using only V1VolumeMount fields", () => {
    const mount = { ...caMount, subPath: "ca.pem", mountPropagation: "None" };
    expect(WorkerVolumeMountSchema.parse(mount)).toEqual(mount);
  });

  it("rejects an unknown top-level key, naming the key", () => {
    expect(
      issueMessages(WorkerVolumeMountSchema.safeParse({ ...caMount, readonly: true }))
    ).toEqual(['unknown key "readonly" (not a V1VolumeMount field)']);
  });
});
