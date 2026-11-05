import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether the module at `moduleUrl` is the script node was asked to run. Node gives the main
 * module's URL by its real path, so the path node was given is resolved through any symlink
 * before the compare; without that, a script called through a symlinked folder does nothing.
 */
export function isMain(moduleUrl, argv = process.argv) {
  if (!argv[1]) return false;
  try {
    return realpathSync(argv[1]) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
