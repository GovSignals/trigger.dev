import { V1Volume, V1VolumeMount } from "@kubernetes/client-node";
import { z } from "zod";
import type { k8s } from "../clients/kubernetes.js";
import { JsonAny } from "../envUtil.js";

/**
 * Relative path (kubelet seccomp root) of the profile blocking only io_uring
 * syscalls. Must match the profile deployed to worker nodes.
 */
export const BLOCK_IO_URING_SECCOMP_PROFILE = "profiles/block-io-uring.json";

/**
 * Node >= 24 always creates io_uring fds, which can't be checkpointed. Blocking
 * io_uring_setup makes libuv fall back to epoll. Other runtimes don't need this,
 * so the profile is only applied for node-24+. Tolerates an "experimental-" prefix.
 */
export function withBlockIoUringSeccompProfile(
  podSpec: Omit<k8s.V1PodSpec, "containers">,
  runtime: string | null | undefined
): Omit<k8s.V1PodSpec, "containers"> {
  const match = runtime ? /^(?:experimental-)?node-(\d+)$/.exec(runtime) : null;
  if (!match || Number(match[1]) < 24) {
    return podSpec;
  }

  return {
    ...podSpec,
    securityContext: {
      ...podSpec.securityContext,
      seccompProfile: {
        type: "Localhost",
        localhostProfile: BLOCK_IO_URING_SECCOMP_PROFILE,
      },
    },
  };
}

/**
 * Appends operator-supplied volumes (KUBERNETES_WORKER_VOLUMES) to a worker pod
 * spec, keeping any volumes already on it. An empty list returns the spec
 * untouched, so pods look exactly as they did before the option existed.
 */
export function withWorkerVolumes(
  podSpec: Omit<k8s.V1PodSpec, "containers">,
  volumes: k8s.V1Volume[]
): Omit<k8s.V1PodSpec, "containers"> {
  if (volumes.length === 0) {
    return podSpec;
  }

  return {
    ...podSpec,
    volumes: [...(podSpec.volumes ?? []), ...volumes],
  };
}

/** Name of the worker pod container that runs the task. */
export const RUN_CONTROLLER_CONTAINER_NAME = "run-controller";

/**
 * Appends operator-supplied mounts (KUBERNETES_WORKER_VOLUME_MOUNTS) to the
 * run-controller container, keeping any mounts already on it. Other containers
 * are left alone. An empty list returns the containers untouched. The
 * containers come last so the call site can wrap the container list inline.
 */
export function withWorkerVolumeMounts(
  volumeMounts: k8s.V1VolumeMount[],
  containers: k8s.V1Container[]
): k8s.V1Container[] {
  if (volumeMounts.length === 0) {
    return containers;
  }

  return containers.map((container) =>
    container.name === RUN_CONTROLLER_CONTAINER_NAME
      ? { ...container, volumeMounts: [...(container.volumeMounts ?? []), ...volumeMounts] }
      : container
  );
}

// The Kubernetes client serializes only the fields it knows and silently drops
// the rest, so a misspelled key (e.g. `configmap`) would reach the API server
// as a bare `{name}` volume, which it defaults to an emptyDir. Reject unknown
// top-level keys instead. Nested objects are passed through unchecked.
const V1_VOLUME_FIELDS = new Set(V1Volume.getAttributeTypeMap().map((attr) => attr.name));
const V1_VOLUME_MOUNT_FIELDS = new Set(
  V1VolumeMount.getAttributeTypeMap().map((attr) => attr.name)
);

/**
 * Item schema for KUBERNETES_WORKER_VOLUMES: a V1Volume with a non-empty name,
 * no fields outside V1Volume, and exactly one volume source whose value is a
 * JSON object.
 */
export const WorkerVolumeSchema = z
  .object({ name: z.string().min(1) })
  .catchall(JsonAny)
  .superRefine((volume, ctx) => {
    const sources: string[] = [];

    for (const [key, value] of Object.entries(volume)) {
      if (key === "name") {
        continue;
      }

      if (!V1_VOLUME_FIELDS.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown key "${key}" (not a V1Volume field)`,
          path: [key],
        });
        continue;
      }

      sources.push(key);

      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `volume source "${key}" must be a JSON object`,
          path: [key],
        });
      }
    }

    if (sources.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `volume "${volume.name}" must have exactly one volume source (got ${
          sources.length === 0 ? "none" : sources.join(", ")
        })`,
      });
    }
  });

/**
 * Item schema for KUBERNETES_WORKER_VOLUME_MOUNTS: a V1VolumeMount with a
 * non-empty name and mountPath and no fields outside V1VolumeMount.
 */
export const WorkerVolumeMountSchema = z
  .object({ name: z.string().min(1), mountPath: z.string().min(1) })
  .catchall(JsonAny)
  .superRefine((mount, ctx) => {
    for (const key of Object.keys(mount)) {
      if (!V1_VOLUME_MOUNT_FIELDS.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown key "${key}" (not a V1VolumeMount field)`,
          path: [key],
        });
      }
    }
  });

export type WorkerVolumeConfigError = {
  envVar: "KUBERNETES_WORKER_VOLUMES" | "KUBERNETES_WORKER_VOLUME_MOUNTS";
  message: string;
};

/**
 * Cross-checks KUBERNETES_WORKER_VOLUMES against KUBERNETES_WORKER_VOLUME_MOUNTS:
 * unique volume names, unique mount paths, and every mount naming a volume.
 * The Kubernetes API would reject every worker pod built from a config that
 * fails these checks, so the supervisor runs them once at startup instead.
 */
export function findWorkerVolumeConfigErrors(
  volumes: k8s.V1Volume[],
  volumeMounts: k8s.V1VolumeMount[]
): WorkerVolumeConfigError[] {
  const errors: WorkerVolumeConfigError[] = [];
  const seen = new Set<string>();
  const reported = new Set<string>();

  for (const { name } of volumes) {
    if (seen.has(name) && !reported.has(name)) {
      reported.add(name);
      errors.push({
        envVar: "KUBERNETES_WORKER_VOLUMES",
        message: `KUBERNETES_WORKER_VOLUMES has more than one volume named "${name}"`,
      });
    }
    seen.add(name);
  }

  const seenPaths = new Set<string>();
  const reportedPaths = new Set<string>();

  for (const { name, mountPath } of volumeMounts) {
    if (!seen.has(name)) {
      errors.push({
        envVar: "KUBERNETES_WORKER_VOLUME_MOUNTS",
        message: `KUBERNETES_WORKER_VOLUME_MOUNTS mounts volume "${name}", which is not defined in KUBERNETES_WORKER_VOLUMES`,
      });
    }

    if (seenPaths.has(mountPath) && !reportedPaths.has(mountPath)) {
      reportedPaths.add(mountPath);
      errors.push({
        envVar: "KUBERNETES_WORKER_VOLUME_MOUNTS",
        message: `KUBERNETES_WORKER_VOLUME_MOUNTS has more than one mount at path "${mountPath}"`,
      });
    }
    seenPaths.add(mountPath);
  }

  return errors;
}
