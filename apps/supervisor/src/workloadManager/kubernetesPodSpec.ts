import type { k8s } from "../clients/kubernetes.js";

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

export type WorkerVolumeConfigError = {
  envVar: "KUBERNETES_WORKER_VOLUMES" | "KUBERNETES_WORKER_VOLUME_MOUNTS";
  message: string;
};

/**
 * Cross-checks KUBERNETES_WORKER_VOLUMES against KUBERNETES_WORKER_VOLUME_MOUNTS.
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

  for (const { name } of volumeMounts) {
    if (!seen.has(name)) {
      errors.push({
        envVar: "KUBERNETES_WORKER_VOLUME_MOUNTS",
        message: `KUBERNETES_WORKER_VOLUME_MOUNTS mounts volume "${name}", which is not defined in KUBERNETES_WORKER_VOLUMES`,
      });
    }
  }

  return errors;
}
