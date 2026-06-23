import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ActiveGoal, CheckerDecision, CheckerSessionContext, CheckerVerdict, GoalControllerConfig, ThinkingLevel } from "./types.ts";
import { buildCheckerPrompt } from "./prompts.ts";

export interface CheckerRunInput {
  goal: ActiveGoal;
  context: CheckerSessionContext;
  config: GoalControllerConfig;
  cwd: string;
  model: ExtensionContext["model"];
  thinkingLevel: ThinkingLevel;
  signal?: AbortSignal;
}

export interface CheckerRunner {
  run(input: CheckerRunInput): Promise<CheckerVerdict>;
}

export class PiSubprocessCheckerRunner implements CheckerRunner {
  public constructor(private readonly pi: Pick<ExtensionAPI, "exec">) {}

  public async run(input: CheckerRunInput): Promise<CheckerVerdict> {
    const prompt = buildCheckerPrompt(input.goal, input.context);
    const args = checkerArgs(input, prompt);
    const result = await this.pi.exec("pi", args, {
      cwd: input.cwd,
      timeout: input.config.checker.timeoutMs,
      signal: input.signal,
    });

    if (result.code !== 0) {
      const stderr = result.stderr.trim();
      throw new Error(stderr || `checker subprocess exited with code ${result.code}`);
    }

    const finalText = finalAssistantTextFromJsonMode(result.stdout) || result.stdout.trim();
    return parseCheckerVerdict(finalText);
  }
}

function checkerArgs(input: CheckerRunInput, prompt: string): string[] {
  const args = ["--mode", "json", "-p", "--no-session"];

  if (input.config.checker.toolMode === "transcript") {
    args.push("--no-extensions", "--no-tools");
  } else if (input.config.checker.toolMode === "inspect") {
    args.push("--no-extensions", "--exclude-tools", "edit,write");
  }

  args.push("--no-skills", "--no-prompt-templates", "--no-context-files");

  const model = resolveModelPattern(input.config.checker.model, input.model);
  if (model) args.push("--model", model);

  const thinking = input.config.checker.thinking === "inherit" ? input.thinkingLevel : input.config.checker.thinking;
  args.push("--thinking", thinking);
  args.push(prompt);
  return args;
}

function resolveModelPattern(setting: string, model: ExtensionContext["model"]): string | undefined {
  if (setting !== "inherit") return setting;
  const provider = stringProperty(model, "provider");
  const id = stringProperty(model, "id");
  if (provider && id) return `${provider}/${id}`;
  return id;
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[key];
  return typeof property === "string" && property.trim().length > 0 ? property.trim() : undefined;
}

function finalAssistantTextFromJsonMode(stdout: string): string | undefined {
  let finalText: string | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const event = safeJsonParse(line);
    if (!isRecord(event) || event.type !== "message_end") continue;
    const message = event.message;
    if (!isRecord(message) || message.role !== "assistant") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        finalText = block.text;
      }
    }
  }
  return finalText;
}

export function parseCheckerVerdict(text: string): CheckerVerdict {
  const parsed = safeJsonParse(extractJsonObject(text));
  if (!isRecord(parsed)) throw new Error(`checker did not return a JSON object: ${text.slice(0, 300)}`);

  const explicitDecision = checkerDecision(parsed.decision);
  const complete = parsed.complete === true || explicitDecision === "complete";
  const blocked = explicitDecision === "blocked" || (explicitDecision === undefined && parsed.blocked === true);
  const decision = explicitDecision ?? (complete ? "complete" : blocked ? "blocked" : "continue");
  const reason = typeof parsed.reason === "string" && parsed.reason.trim().length > 0 ? parsed.reason.trim() : complete ? "Checker marked the goal complete." : "Checker did not find the goal complete.";
  const evidence = stringArray(parsed.evidence);
  const requirementVerdicts = requirements(parsed.requirements);

  if (complete) {
    assertCompleteVerdictHasEvidence(evidence, requirementVerdicts);
  }

  return {
    decision,
    complete,
    blocked,
    reason,
    nextTurnGuidance: stringArrayOrString(parsed.nextTurnGuidance),
    evidence,
    unmetRequirements: stringArray(parsed.unmetRequirements),
    requirements: requirementVerdicts,
  };
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed)?.[1];
  const candidate = fenced?.trim() ?? trimmed;
  if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) return candidate.slice(start, end + 1);
  return candidate;
}

function requirements(value: unknown): CheckerVerdict["requirements"] {
  if (!Array.isArray(value)) return undefined;
  const result: NonNullable<CheckerVerdict["requirements"]> = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const requirement = typeof item.requirement === "string" ? item.requirement : undefined;
    const status = item.status;
    if (!requirement || !isRequirementStatus(status)) continue;
    result.push({
      requirement,
      status,
      evidence: typeof item.evidence === "string" ? item.evidence : undefined,
    });
  }
  return result.length > 0 ? result : undefined;
}

function checkerDecision(value: unknown): CheckerDecision | undefined {
  if (value === "complete" || value === "continue" || value === "waiting_for_user" || value === "blocked") return value;
  return undefined;
}

function isRequirementStatus(value: unknown): value is "satisfied" | "unsatisfied" | "unclear" | "not_applicable" {
  return value === "satisfied" || value === "unsatisfied" || value === "unclear" || value === "not_applicable";
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return strings.length > 0 ? strings : undefined;
}

function stringArrayOrString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  const array = stringArray(value);
  return array?.join("\n");
}

function assertCompleteVerdictHasEvidence(
  evidence: string[] | undefined,
  requirementVerdicts: CheckerVerdict["requirements"],
): void {
  if (!evidence || evidence.length === 0) {
    throw new Error("complete checker verdict must include at least one evidence item");
  }
  if (!requirementVerdicts || requirementVerdicts.length === 0) {
    throw new Error("complete checker verdict must include requirement-by-requirement assessment");
  }
  const unproven = requirementVerdicts.filter((item) => item.status !== "satisfied" && item.status !== "not_applicable");
  if (unproven.length > 0) {
    throw new Error(`complete checker verdict has unproven requirements: ${unproven.map((item) => item.requirement).join(", ")}`);
  }
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
