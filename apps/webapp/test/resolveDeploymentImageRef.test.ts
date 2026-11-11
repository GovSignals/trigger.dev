import { describe, expect, it } from "vitest";
import {
  ImageReferenceMismatchError,
  parseImageRef,
  resolveOverrideImageRef,
} from "../app/v3/services/initializeDeployment/resolveDeploymentImageRef";

describe("parseImageRef", () => {
  it("splits registry/repository and tag", () => {
    expect(parseImageRef("registry.example.com/acme/tasks:0.0.106")).toEqual({
      repository: "registry.example.com/acme/tasks",
      tag: "0.0.106",
      digest: undefined,
    });
  });

  it("treats a registry:port host as part of the repository, not a tag", () => {
    expect(parseImageRef("localhost:5001/tasks")).toEqual({
      repository: "localhost:5001/tasks",
      tag: undefined,
      digest: undefined,
    });
  });

  it("handles registry:port host with a tag", () => {
    expect(parseImageRef("localhost:5001/tasks:0.0.106")).toEqual({
      repository: "localhost:5001/tasks",
      tag: "0.0.106",
      digest: undefined,
    });
  });

  it("strips a trailing @sha256 digest", () => {
    expect(
      parseImageRef(
        "123456789012.dkr.ecr.us-east-1.amazonaws.com/acme/tasks:0.0.107@sha256:" + "a".repeat(64)
      )
    ).toEqual({
      repository: "123456789012.dkr.ecr.us-east-1.amazonaws.com/acme/tasks",
      tag: "0.0.107",
      digest: "sha256:" + "a".repeat(64),
    });
  });
});

describe("resolveOverrideImageRef", () => {
  const override = "registry.example.com/acme/tasks:0.0.104";

  it("returns the override verbatim when no client imageReference is supplied", () => {
    expect(resolveOverrideImageRef({ override })).toBe(override);
  });

  it("returns the client imageReference when it shares the override registry/repository", () => {
    const clientImageReference = "registry.example.com/acme/tasks:0.0.106";
    expect(resolveOverrideImageRef({ override, clientImageReference })).toBe(clientImageReference);
  });

  it("allows the client imageReference to add a digest to the same tag", () => {
    const clientImageReference = "registry.example.com/acme/tasks:0.0.104@sha256:" + "b".repeat(64);
    expect(resolveOverrideImageRef({ override, clientImageReference })).toBe(clientImageReference);
  });

  it("allows the client imageReference to differ by both tag and digest", () => {
    const clientImageReference = "registry.example.com/acme/tasks:0.0.106@sha256:" + "c".repeat(64);
    expect(resolveOverrideImageRef({ override, clientImageReference })).toBe(clientImageReference);
  });

  it("throws when the client imageReference repository differs from the override", () => {
    const clientImageReference = "evil.example.com/attacker/image:latest";
    expect(() => resolveOverrideImageRef({ override, clientImageReference })).toThrow(
      ImageReferenceMismatchError
    );
  });

  it("throws when only the registry host differs (same path)", () => {
    const clientImageReference = "evil.example.com/acme/tasks:0.0.106";
    expect(() => resolveOverrideImageRef({ override, clientImageReference })).toThrow(
      ImageReferenceMismatchError
    );
  });
});
