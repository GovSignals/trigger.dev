import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { calculateNextBuildVersion } from "../app/v3/utils/calculateNextBuildVersion";

describe("calculateNextBuildVersion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-02-08T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("starts at YYYYMMDD.1 when there's no previous version", () => {
    expect(calculateNextBuildVersion(null)).toBe("20250208.1");
    expect(calculateNextBuildVersion(undefined)).toBe("20250208.1");
    expect(calculateNextBuildVersion("")).toBe("20250208.1");
  });

  test("appends suffix when starting fresh", () => {
    expect(calculateNextBuildVersion(null, "hardened")).toBe("20250208.1-hardened");
  });

  test("increments build number on same day", () => {
    expect(calculateNextBuildVersion("20250208.1")).toBe("20250208.2");
    expect(calculateNextBuildVersion("20250208.5")).toBe("20250208.6");
  });

  test("resets to .1 on a new day", () => {
    expect(calculateNextBuildVersion("20250207.5")).toBe("20250208.1");
  });

  test("ignores existing suffix on the latest version", () => {
    // The new version uses the caller-provided suffix, not the existing one.
    expect(calculateNextBuildVersion("20250208.1-old")).toBe("20250208.2");
    expect(calculateNextBuildVersion("20250208.1-old", "new")).toBe("20250208.2-new");
    expect(calculateNextBuildVersion("20250208.1-old", undefined)).toBe("20250208.2");
  });

  test("handles multi-hyphen suffix on the latest version (regression test)", () => {
    // Before the fix, split("-") destructured `existingSuffix = "pre"` from
    // "20250208.1-pre-rc.1" — unused but misleading. baseVersion was correct
    // because `split("-")[0]` works regardless of segment count.
    expect(calculateNextBuildVersion("20250208.1-pre-rc.1")).toBe("20250208.2");
    expect(calculateNextBuildVersion("20250208.1-pre-rc.1", "hardened")).toBe(
      "20250208.2-hardened"
    );
  });
});
