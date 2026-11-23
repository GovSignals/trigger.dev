import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectStoreClient } from "~/v3/objectStoreClient.server";

// Presigning is local SigV4 signing, so these tests need no network or containers.
// Static env credentials stand in for the IAM credential chain the client resolves at sign time.
const FIPS_ENDPOINT = "https://s3-fips.us-gov-west-1.amazonaws.com";
const BUCKET = "trigger-bucket";
const KEY = `${BUCKET}/packets/proj_123/run_456/payload.json`;

function iamClient(forcePathStyle?: boolean) {
  return ObjectStoreClient.create({
    baseUrl: FIPS_ENDPOINT,
    bucket: BUCKET,
    region: "us-gov-west-1",
    ...(forcePathStyle === undefined ? {} : { forcePathStyle }),
  });
}

describe("ObjectStoreClient IAM-mode addressing", () => {
  beforeEach(() => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    vi.stubEnv("AWS_SESSION_TOKEN", undefined);
    vi.stubEnv("AWS_PROFILE", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps path-style URLs when forcePathStyle is not set", async () => {
    const url = new URL(await iamClient().presign(KEY, "PUT", 300));

    expect(url.host).toBe("s3-fips.us-gov-west-1.amazonaws.com");
    expect(url.pathname).toBe(`/${KEY}`);
  });

  it("uses virtual-hosted URLs when forcePathStyle is false", async () => {
    const url = new URL(await iamClient(false).presign(KEY, "PUT", 300));

    expect(url.host).toBe(`${BUCKET}.s3-fips.us-gov-west-1.amazonaws.com`);
    expect(url.pathname).toBe("/packets/proj_123/run_456/payload.json");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
  });

  it("applies the same addressing to GET presigns", async () => {
    const url = new URL(await iamClient(false).presign(KEY, "GET", 300));

    expect(url.host).toBe(`${BUCKET}.s3-fips.us-gov-west-1.amazonaws.com`);
    expect(url.pathname).toBe("/packets/proj_123/run_456/payload.json");
  });
});
