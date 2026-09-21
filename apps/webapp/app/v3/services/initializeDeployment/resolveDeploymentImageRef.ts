/**
 * Pure resolution of the deployment image reference for single-tenant installs
 * that set `DEPLOY_IMAGE_OVERRIDE`. Kept free of env/DB imports so it can be
 * unit-tested directly (mirrors the `createDeploymentWithNextVersion` helper).
 *
 * Background: the override is the opt-in switch for the "pre-built canonical
 * image" flow. When a caller (e.g. a self-hosted deploy hook that has already
 * built and pushed the image) supplies its own `imageReference`, we honor it
 * instead of the webapp pod's boot-time override snapshot so the stamped image
 * is deterministic and not a function of pod rollout timing. To bound the
 * supply-chain surface, the caller-supplied reference must share the override's
 * registry + repository; the tag (version) and/or digest may differ.
 */

export class ImageReferenceMismatchError extends Error {
  readonly name = "ImageReferenceMismatchError";
  readonly clientRepository: string;
  readonly overrideRepository: string;

  constructor(args: { clientRepository: string; overrideRepository: string }) {
    super(
      `Client imageReference repository "${args.clientRepository}" does not match the configured DEPLOY_IMAGE_OVERRIDE repository "${args.overrideRepository}"`
    );
    this.clientRepository = args.clientRepository;
    this.overrideRepository = args.overrideRepository;
  }
}

/**
 * Split an image reference into its repository (registry host + path) and its
 * tag/digest. Tolerates a `registry:port` host (the tag is only the segment
 * after the last `:` that follows the last `/`) and a trailing `@sha256:...`
 * digest.
 */
export function parseImageRef(imageRef: string): {
  repository: string;
  tag?: string;
  digest?: string;
} {
  let rest = imageRef;
  let digest: string | undefined;

  const atIndex = rest.indexOf("@");
  if (atIndex !== -1) {
    digest = rest.slice(atIndex + 1);
    rest = rest.slice(0, atIndex);
  }

  const lastSlash = rest.lastIndexOf("/");
  const lastColon = rest.lastIndexOf(":");

  // A colon denotes a tag only when it comes after the last path separator;
  // otherwise it is the `registry:port` host separator and there is no tag.
  if (lastColon > lastSlash) {
    return {
      repository: rest.slice(0, lastColon),
      tag: rest.slice(lastColon + 1),
      digest,
    };
  }

  return { repository: rest, digest };
}

/**
 * Resolve the image reference to stamp on a deployment when
 * `DEPLOY_IMAGE_OVERRIDE` is set.
 *
 * - No caller-supplied reference -> use the override verbatim (prior behavior).
 * - Caller-supplied reference -> require the same registry/repository as the
 *   override and use it (so the tag/digest can move ahead deterministically).
 *
 * Throws {@link ImageReferenceMismatchError} when the repositories differ.
 */
export function resolveOverrideImageRef(args: {
  override: string;
  clientImageReference?: string;
}): string {
  const { override, clientImageReference } = args;

  if (!clientImageReference) {
    return override;
  }

  const overrideRepository = parseImageRef(override).repository;
  const clientRepository = parseImageRef(clientImageReference).repository;

  if (overrideRepository !== clientRepository) {
    throw new ImageReferenceMismatchError({ clientRepository, overrideRepository });
  }

  return clientImageReference;
}
