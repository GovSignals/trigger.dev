import { describe, expect, test } from "vitest";
import { compareDeploymentVersions } from "../app/v3/utils/deploymentVersions";

describe("compareDeploymentVersions", () => {
  describe("base versions only (no suffix)", () => {
    test("orders by date ascending", () => {
      expect(compareDeploymentVersions("20250101.1", "20250102.1")).toBe(-1);
      expect(compareDeploymentVersions("20250102.1", "20250101.1")).toBe(1);
    });

    test("orders by build number when dates are equal", () => {
      expect(compareDeploymentVersions("20250101.1", "20250101.2")).toBe(-1);
      expect(compareDeploymentVersions("20250101.2", "20250101.1")).toBe(1);
      expect(compareDeploymentVersions("20250101.10", "20250101.2")).toBe(1);
    });

    test("treats identical versions as equal", () => {
      expect(compareDeploymentVersions("20250101.1", "20250101.1")).toBe(0);
    });
  });

  describe("with single-segment suffixes", () => {
    test("versions without suffix sort before versions with suffix", () => {
      expect(compareDeploymentVersions("20250101.1", "20250101.1-hardened")).toBe(-1);
      expect(compareDeploymentVersions("20250101.1-hardened", "20250101.1")).toBe(1);
    });

    test("orders suffixes alphabetically when bases are equal", () => {
      expect(compareDeploymentVersions("20250101.1-alpha", "20250101.1-beta")).toBe(-1);
      expect(compareDeploymentVersions("20250101.1-beta", "20250101.1-alpha")).toBe(1);
    });

    test("equal suffixes return 0", () => {
      expect(compareDeploymentVersions("20250101.1-foo", "20250101.1-foo")).toBe(0);
    });
  });

  describe("with multi-hyphen suffixes (regression test)", () => {
    test("does NOT tie-break two distinct multi-hyphen suffixes as equal", () => {
      // Before the fix: split("-") returned ["20250101.1","pre","rc.1"], destructured
      // suffix = "pre" — so both versions would compare as equal.
      const a = "20250101.1-pre-rc.1";
      const b = "20250101.1-pre-rc.2";
      expect(compareDeploymentVersions(a, b)).not.toBe(0);
      expect(compareDeploymentVersions(a, b)).toBe(-1);
      expect(compareDeploymentVersions(b, a)).toBe(1);
    });

    test("preserves full suffix in sort", () => {
      expect(compareDeploymentVersions("20250101.1-a-b", "20250101.1-a-c")).toBe(-1);
      expect(compareDeploymentVersions("20250101.1-x-y-z", "20250101.1-x-y-z")).toBe(0);
    });
  });
});
