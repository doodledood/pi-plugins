export const CHECKER_AUDIT_TOOLS = ["read", "grep", "find", "ls"] as const;
export const CHECKER_AUDIT_TOOLS_ARG = CHECKER_AUDIT_TOOLS.join(",");

export const CHECKER_DISABLED_RESOURCE_ARGS = ["--no-extensions", "--no-prompt-templates", "--no-context-files"] as const;

export const CHECKER_DISABLED_SURFACES = [
  "extension tools",
  "prompt templates",
  "context files",
  "shell execution",
  "file mutation tools",
] as const;

export function checkerAuditProfilePromptText(): string {
  return `Your checker subprocess has one fixed audit-only capability profile: read/search/list tools (${CHECKER_AUDIT_TOOLS.join(", ")}) and skill discovery. ${sentenceList(CHECKER_DISABLED_SURFACES)} are unavailable by design.`;
}

function sentenceList(values: readonly string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}
