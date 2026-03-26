// Compares two versions of a deployment, like 20250208.1 and 20250208.2
// Also handles versions with suffixes like 20250208.1-hardened
// Returns -1 if versionA is older than versionB, 0 if they are the same, and 1 if versionA is newer than versionB
export function compareDeploymentVersions(versionA: string, versionB: string) {
  // Extract base versions and suffixes
  const [baseVersionA, suffixA = ""] = versionA.split("-");
  const [baseVersionB, suffixB = ""] = versionB.split("-");
  
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
