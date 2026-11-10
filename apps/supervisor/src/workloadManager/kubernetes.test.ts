import { describe, expect, it } from "vitest";
import {
  BLOCK_IO_URING_SECCOMP_PROFILE,
  findWorkerVolumeConfigErrors,
  withBlockIoUringSeccompProfile,
  withWorkerVolumeMounts,
  withWorkerVolumes,
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

  it("reports two volumes sharing a name once, naming the env var", () => {
    expect(findWorkerVolumeConfigErrors([caVolume, caVolume, caVolume], [caMount])).toEqual([
      {
        envVar: "KUBERNETES_WORKER_VOLUMES",
        message: 'KUBERNETES_WORKER_VOLUMES has more than one volume named "extra-ca"',
      },
    ]);
  });
});
