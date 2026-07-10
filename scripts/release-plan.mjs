import { pathToFileURL } from "node:url";

export function planReleaseActions({ isCurrentCommit, tagExists, releaseExists }) {
  return {
    verifyCandidate: !tagExists && !isCurrentCommit,
    createTag: !tagExists,
    createRelease: !releaseExists,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , isCurrentCommit, tagExists, releaseExists] = process.argv;
  if ([isCurrentCommit, tagExists, releaseExists].some((value) => !["true", "false"].includes(value))) {
    console.error("usage: node scripts/release-plan.mjs <is-current> <tag-exists> <release-exists>");
    process.exit(2);
  }
  console.log(
    JSON.stringify(
      planReleaseActions({
        isCurrentCommit: isCurrentCommit === "true",
        tagExists: tagExists === "true",
        releaseExists: releaseExists === "true",
      }),
    ),
  );
}
