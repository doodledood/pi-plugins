import { isAbsolute } from "node:path";
import type { CheckerTrustedModelBootstrapPackage } from "./types.ts";

export const CHECKER_MODEL_BOOTSTRAP_PROTOCOL_VERSION = 1;
export const CHECKER_MODEL_BOOTSTRAP_REQUEST_CHANNEL = "goal-controller:checker-model-bootstrap:request";
export const CHECKER_MODEL_BOOTSTRAP_REGISTER_CHANNEL = "goal-controller:checker-model-bootstrap:register";
export const CHECKER_MODEL_BOOTSTRAP_KIND = "model-provider-bootstrap";
export const CHECKER_MODEL_BOOTSTRAP_TOOL_SURFACE = "none";

export const DEFAULT_TRUSTED_CHECKER_MODEL_BOOTSTRAP_PACKAGES: CheckerTrustedModelBootstrapPackage[] = [
  {
    packageName: "@doodledood/pi-model-aliases",
    extensionPathSuffixes: ["/extensions/model-aliases/checker-bootstrap.ts"],
  },
];

export interface CheckerModelBootstrapRequest {
  protocolVersion: typeof CHECKER_MODEL_BOOTSTRAP_PROTOCOL_VERSION;
  consumerPackage: "@doodledood/pi-goal-controller";
}

export interface CheckerModelBootstrapRegistration {
  protocolVersion: typeof CHECKER_MODEL_BOOTSTRAP_PROTOCOL_VERSION;
  kind: typeof CHECKER_MODEL_BOOTSTRAP_KIND;
  toolSurface: typeof CHECKER_MODEL_BOOTSTRAP_TOOL_SURFACE;
  packageName: string;
  extensionPath: string;
}

export function checkerModelBootstrapRequest(): CheckerModelBootstrapRequest {
  return {
    protocolVersion: CHECKER_MODEL_BOOTSTRAP_PROTOCOL_VERSION,
    consumerPackage: "@doodledood/pi-goal-controller",
  };
}

export function checkerModelBootstrapRegistration(value: unknown): CheckerModelBootstrapRegistration | undefined {
  if (!isRecord(value)) return undefined;
  if (value.protocolVersion !== CHECKER_MODEL_BOOTSTRAP_PROTOCOL_VERSION) return undefined;
  if (value.kind !== CHECKER_MODEL_BOOTSTRAP_KIND) return undefined;
  if (value.toolSurface !== CHECKER_MODEL_BOOTSTRAP_TOOL_SURFACE) return undefined;
  const packageName = nonEmptyString(value.packageName);
  // The path becomes a `pi -e <path>` argument in the checker subprocess, so it
  // must be an absolute, canonical file path. A relative path from an untrusted
  // event payload would resolve against the checker's cwd and could load the
  // wrong file, so reject anything that is not absolute here.
  const extensionPath = absolutePath(value.extensionPath);
  if (!packageName || !extensionPath) return undefined;
  return {
    protocolVersion: CHECKER_MODEL_BOOTSTRAP_PROTOCOL_VERSION,
    kind: CHECKER_MODEL_BOOTSTRAP_KIND,
    toolSurface: CHECKER_MODEL_BOOTSTRAP_TOOL_SURFACE,
    packageName,
    extensionPath,
  };
}

export function trustedCheckerModelBootstrapPath(
  registration: CheckerModelBootstrapRegistration,
  trustedPackages: readonly CheckerTrustedModelBootstrapPackage[],
): string | undefined {
  const trusted = trustedPackages.find((candidate) => candidate.packageName === registration.packageName);
  if (!trusted) return undefined;
  if (!trusted.extensionPathSuffixes || trusted.extensionPathSuffixes.length === 0) return registration.extensionPath;
  const normalizedPath = normalizePathForSuffix(registration.extensionPath);
  const hasTrustedSuffix = trusted.extensionPathSuffixes.some((suffix) => normalizedPath.endsWith(normalizePathForSuffix(suffix)));
  return hasTrustedSuffix ? registration.extensionPath : undefined;
}

export function normalizeCheckerModelBootstrapPaths(paths: readonly unknown[] | undefined): string[] {
  const normalized = new Set<string>();
  for (const path of paths ?? []) {
    const value = nonEmptyString(path);
    if (value) normalized.add(value);
  }
  return [...normalized];
}

function normalizePathForSuffix(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function absolutePath(value: unknown): string | undefined {
  const trimmed = nonEmptyString(value);
  if (!trimmed) return undefined;
  return isAbsolute(trimmed) ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
