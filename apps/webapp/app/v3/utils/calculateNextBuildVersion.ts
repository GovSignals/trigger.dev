// Calculate next build version based on the previous version
// Version formats are YYYYMMDD.1, YYYYMMDD.2, etc.
// With optional suffix: YYYYMMDD.1-suffix
// If there is no previous version, start at Todays date and .1
export function calculateNextBuildVersion(latestVersion?: string | null, suffix?: string): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const day = today.getDate();
  const todayFormatted = `${year}${month < 10 ? "0" : ""}${month}${day < 10 ? "0" : ""}${day}`;

  if (!latestVersion) {
    const baseVersion = `${todayFormatted}.1`;
    return suffix ? `${baseVersion}-${suffix}` : baseVersion;
  }

  // Extract base version (everything before the first hyphen) — any existing
  // suffix is intentionally discarded; the new version takes the suffix passed
  // by the caller, which may differ. Avoid `split("-")` indexed destructuring
  // here so multi-hyphen suffixes don't read confusingly.
  const hyphenIndex = latestVersion.indexOf("-");
  const baseVersion =
    hyphenIndex === -1 ? latestVersion : latestVersion.slice(0, hyphenIndex);
  const [date, buildNumber] = baseVersion.split(".");

  if (date === todayFormatted) {
    const nextBuildNumber = parseInt(buildNumber, 10) + 1;
    const newBaseVersion = `${date}.${nextBuildNumber}`;
    return suffix ? `${newBaseVersion}-${suffix}` : newBaseVersion;
  }

  const newBaseVersion = `${todayFormatted}.1`;
  return suffix ? `${newBaseVersion}-${suffix}` : newBaseVersion;
}
