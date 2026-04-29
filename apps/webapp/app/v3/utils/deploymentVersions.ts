// Compares two versions of a deployment, like 20250208.1 and 20250208.2
// Also handles versions with suffixes like 20250208.1-hardened
// Returns -1 if versionA is older than versionB, 0 if they are the same, and 1 if versionA is newer than versionB

const splitDeploymentVersion = (version: string): { base: string; suffix: string } => {
  const hyphenIndex = version.indexOf("-");
  if (hyphenIndex === -1) {
    return { base: version, suffix: "" };
  }
  return {
    base: version.slice(0, hyphenIndex),
    // Capture everything after the first hyphen so multi-hyphen suffixes
    // (e.g. "20250208.1-pre-rc.1") are preserved intact.
    suffix: version.slice(hyphenIndex + 1),
  };
};

export function compareDeploymentVersions(versionA: string, versionB: string) {
  const { base: baseVersionA, suffix: suffixA } = splitDeploymentVersion(versionA);
  const { base: baseVersionB, suffix: suffixB } = splitDeploymentVersion(versionB);

  const [dateA, numberA] = baseVersionA.split(".");
  const [dateB, numberB] = baseVersionB.split(".");

  if (dateA < dateB) {
    return -1;
  }

  if (dateA > dateB) {
    return 1;
  }

  // Convert to numbers before comparing
  const numA = Number(numberA);
  const numB = Number(numberB);

  if (numA < numB) {
    return -1;
  }

  if (numA > numB) {
    return 1;
  }

  // Base versions are equal, compare suffixes alphabetically
  // Versions without suffixes should come before versions with suffixes
  if (suffixA === "" && suffixB !== "") {
    return -1;
  }
  if (suffixA !== "" && suffixB === "") {
    return 1;
  }
  if (suffixA < suffixB) {
    return -1;
  }
  if (suffixA > suffixB) {
    return 1;
  }

  return 0;
}
