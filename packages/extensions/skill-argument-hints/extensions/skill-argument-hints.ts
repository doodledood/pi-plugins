// skill-argument-hints.ts — show Claude Code-style phantom argument hints for Pi skills.
//
// Pi already supports `argument-hint` for prompt templates. This extension adds the
// same metadata to `/skill:<name>` invocations, but renders it as phantom text in
// the editor after the skill command is completed, leaving the autocomplete list's
// description column focused on the skill description.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CustomEditor, type ExtensionAPI, type KeybindingsManager, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, AutocompleteSuggestions, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type HintCacheEntry = {
  mtimeMs: number;
  hint: string | undefined;
};

const COMMAND_PREFIX = "skill:";
const SUPPORTED_FRONTMATTER_KEYS = ["argument-hint", "argumentHint", "argument_hint"];
const MAX_LISTED_HINTS = 25;
const CURSOR_AT_END = "\u001b[7m \u001b[0m";

export default function skillArgumentHints(pi: ExtensionAPI): void {
  const hintCache = new Map<string, HintCacheEntry>();

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") {
      return;
    }

    ctx.ui.addAutocompleteProvider((current) => createSourceTagCleanupProvider(current));
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new SkillHintEditor(tui, theme, keybindings, pi, hintCache));
  });

  pi.registerCommand("skill-hints", {
    description: "List skills that define an argument-hint frontmatter field.",
    handler: async (_args, ctx) => {
      const hints = getSkillHints(pi, hintCache);
      if (hints.size === 0) {
        ctx.ui.notify("No loaded skills define argument-hint frontmatter.", "info");
        return;
      }

      const lines = [...hints.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, MAX_LISTED_HINTS)
        .map(([command, hint]) => `/${command} ${hint}`);
      const suffix = hints.size > MAX_LISTED_HINTS ? `\n…and ${hints.size - MAX_LISTED_HINTS} more` : "";
      ctx.ui.notify(`Skill argument hints:\n${lines.join("\n")}${suffix}`, "info");
    },
  });
}

class SkillHintEditor extends CustomEditor {
  constructor(
    tui: TUI,
    private readonly editorTheme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly pi: ExtensionAPI,
    private readonly hintCache: Map<string, HintCacheEntry>,
  ) {
    super(tui, editorTheme, keybindings);
  }

  override render(width: number): string[] {
    const hint = this.getCurrentPlaceholderHint();
    const lines = super.render(width);
    if (!hint) {
      return lines;
    }

    const lineIndex = lines.findIndex((line) => line.includes(CURSOR_AT_END));
    if (lineIndex === -1) {
      return lines;
    }

    const styledHint = this.editorTheme.selectList.description(hint);
    const withHint = lines[lineIndex]!.replace(CURSOR_AT_END, `${CURSOR_AT_END}${styledHint}`).replace(/ +$/u, "");
    lines[lineIndex] = visibleWidth(withHint) > width
      ? truncateToWidth(withHint, width, "…", true)
      : `${withHint}${" ".repeat(Math.max(0, width - visibleWidth(withHint)))}`;

    return lines;
  }

  private getCurrentPlaceholderHint(): string | undefined {
    const text = this.getText();
    if (text.includes("\n")) {
      return undefined;
    }

    const cursor = this.getCursor();
    if (cursor.line !== 0 || cursor.col !== text.length) {
      return undefined;
    }

    const match = text.match(/^\/([^\s]+)(\s*)$/u);
    if (!match) {
      return undefined;
    }

    const commandName = match[1] ?? "";
    if (!commandName.startsWith(COMMAND_PREFIX)) {
      return undefined;
    }

    const hint = getSkillHint(this.pi, this.hintCache, commandName);
    if (!hint) {
      return undefined;
    }

    return text.endsWith(" ") || text.endsWith("\t") ? hint : ` ${hint}`;
  }
}

function createSourceTagCleanupProvider(current: AutocompleteProvider): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      if (!suggestions || !isSlashCommandListContext(lines, cursorLine, cursorCol, options.force ?? false)) {
        return suggestions;
      }

      let changed = false;
      const items = suggestions.items.map((item) => {
        const description = prettifySourceTag(item.description);
        if (description === item.description) {
          return item;
        }
        changed = true;
        return description ? { ...item, description } : withoutDescription(item);
      });

      return changed ? { ...suggestions, items } : suggestions;
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

function isSlashCommandListContext(lines: string[], cursorLine: number, cursorCol: number, force: boolean): boolean {
  if (force) {
    return false;
  }

  const currentLine = lines[cursorLine] ?? "";
  const textBeforeCursor = currentLine.slice(0, cursorCol);
  return textBeforeCursor.startsWith("/") && !textBeforeCursor.includes(" ");
}

function prettifySourceTag(description: string | undefined): string | undefined {
  if (!description) {
    return description;
  }

  const match = description.match(/^\[([^\]]+)\]\s*(.*)$/u);
  if (!match) {
    return description;
  }

  const shortSource = formatShortSource(match[1] ?? "");
  const rest = (match[2] ?? "").trim();
  if (!shortSource) {
    return rest || undefined;
  }

  return rest ? `${shortSource} ${rest}` : shortSource;
}

function formatShortSource(tag: string): string | undefined {
  if (tag === "u" || tag === "p" || tag === "t") {
    return undefined;
  }

  const gitMatch = tag.match(/^(?:[upt]:)?git:[^/]+\/(.+)$/u);
  if (gitMatch) {
    const repoPath = (gitMatch[1] ?? "").split("@")[0] ?? "";
    const repoName = repoPath.split("/").filter(Boolean).pop();
    return repoName ? `(${repoName})` : undefined;
  }

  const npmMatch = tag.match(/^(?:[upt]:)?npm:(.+)$/u);
  if (npmMatch) {
    const packageName = stripNpmVersion(npmMatch[1] ?? "");
    return packageName ? `(${packageName.split("/").pop() ?? packageName})` : undefined;
  }

  const tail = tag.split(/[/:]/u).filter(Boolean).pop();
  return tail ? `(${tail})` : undefined;
}

function stripNpmVersion(packageSpec: string): string {
  if (!packageSpec.startsWith("@")) {
    return packageSpec.split("@")[0] ?? packageSpec;
  }

  const versionSeparator = packageSpec.indexOf("@", 1);
  return versionSeparator === -1 ? packageSpec : packageSpec.slice(0, versionSeparator);
}

function withoutDescription<T extends { description?: string }>(item: T): Omit<T, "description"> {
  const { description: _description, ...rest } = item;
  return rest;
}

function getSkillHint(pi: ExtensionAPI, hintCache: Map<string, HintCacheEntry>, commandName: string): string | undefined {
  const command = pi.getCommands().find((candidate) => candidate.source === "skill" && candidate.name === commandName);
  if (!command) {
    return undefined;
  }

  const skillPath = resolveSkillFilePath(command);
  return skillPath ? readCachedArgumentHint(skillPath, hintCache) : undefined;
}

function getSkillHints(pi: ExtensionAPI, hintCache: Map<string, HintCacheEntry>): Map<string, string> {
  const result = new Map<string, string>();

  for (const command of pi.getCommands()) {
    if (command.source !== "skill" || !command.name.startsWith(COMMAND_PREFIX)) {
      continue;
    }

    const skillPath = resolveSkillFilePath(command);
    if (!skillPath) {
      continue;
    }

    const hint = readCachedArgumentHint(skillPath, hintCache);
    if (hint) {
      result.set(command.name, hint);
    }
  }

  return result;
}

function resolveSkillFilePath(command: SlashCommandInfo): string | undefined {
  const candidates = [
    command.sourceInfo.path,
    command.sourceInfo.baseDir ? join(command.sourceInfo.baseDir, "SKILL.md") : undefined,
    join(command.sourceInfo.path, "SKILL.md"),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function readCachedArgumentHint(path: string, cache: Map<string, HintCacheEntry>): string | undefined {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return undefined;
  }

  const cached = cache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.hint;
  }

  let hint: string | undefined;
  try {
    hint = parseArgumentHint(readFileSync(path, "utf8"));
  } catch {
    hint = undefined;
  }

  cache.set(path, { mtimeMs, hint });
  return hint;
}

function parseArgumentHint(markdown: string): string | undefined {
  const normalized = markdown.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) {
    return undefined;
  }

  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return undefined;
  }

  const frontmatterLines: string[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line?.trim() === "---") {
      return parseArgumentHintFromFrontmatter(frontmatterLines);
    }
    frontmatterLines.push(line ?? "");
  }

  return undefined;
}

function parseArgumentHintFromFrontmatter(lines: string[]): string | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match || !SUPPORTED_FRONTMATTER_KEYS.includes(match[1] ?? "")) {
      continue;
    }

    const rawValue = match[2] ?? "";
    if (rawValue === "|" || rawValue === ">") {
      return parseBlockScalar(lines, index + 1);
    }

    return normalizeYamlScalar(rawValue);
  }

  return undefined;
}

function parseBlockScalar(lines: string[], startIndex: number): string | undefined {
  const blockLines: string[] = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!/^\s+/.test(line)) {
      break;
    }
    blockLines.push(line.trim());
  }

  return normalizeHint(blockLines.join(" "));
}

function normalizeYamlScalar(rawValue: string): string | undefined {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return undefined;
  }

  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    const unquoted = trimmed.slice(1, -1);
    return normalizeHint(quote === '"' ? unescapeDoubleQuotedYaml(unquoted) : unquoted.replace(/''/g, "'"));
  }

  return normalizeHint(trimmed.replace(/\s+#.*$/, ""));
}

function unescapeDoubleQuotedYaml(value: string): string {
  return value.replace(/\\(["\\/bfnrt])/g, (_match, escaped: string) => {
    switch (escaped) {
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return escaped;
    }
  });
}

function normalizeHint(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

