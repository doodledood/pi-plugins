// The real-model contract: does a real model reach for start_agent_session when asked for
// sessions, and only then? The orchestrator runs on the person's configured default model; the
// sessions it starts run on the scripted fake provider. Each run spends real model credit.
//
//   npm run contract --workspace @doodledood/pi-herdr-bridge [-- [--runs N] <case> ...]
//
// Cases: orchestrate, joke, subagent. With none named, all run; each must pass every run (3 by default).
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRIDGE_EXTENSION, Failure, RPIV_DIALOG, Run, SCRIPTED_PROVIDER, check, entries, transcript, waitFor, wakeups } from "./harness.ts";

const AGENT = join(homedir(), ".pi", "agent");
const ORCHESTRATE_SKILL = join(AGENT, "git", "github.com", "doodledood", "manifest-dev", "claude-plugins", "manifest-dev", "skills");
const SUBAGENTS = join(AGENT, "npm", "node_modules", "@gotgenes", "pi-subagents", "src", "index.ts");
const MODEL_ALIASES_EXTENSION = join(AGENT, "git", "github.com", "doodledood", "pi-plugins", "packages", "extensions", "model-aliases", "extensions", "model-aliases", "index.ts");
const USER_SKILLS = join(AGENT, "skills");

/** The person's configured default model, which the orchestrator must run on. */
function configuredModel(): { provider: string; model: string } {
  const settings = JSON.parse(readFileSync(join(AGENT, "settings.json"), "utf8"));
  if (!settings.defaultProvider || !settings.defaultModel) throw new Failure("FAIL: the person's settings name no default model");
  return { provider: settings.defaultProvider, model: settings.defaultModel };
}

/** Launch step 4 and the opening paragraph of "Check in", read from the installed orchestrate skill now. */
export function orchestrateWording(): { launch: string; checkIn: string } {
  const skill = readFileSync(join(ORCHESTRATE_SKILL, "orchestrate", "SKILL.md"), "utf8");
  const launchSection = skill.slice(skill.indexOf("## Launch"), skill.indexOf("## Check in"));
  const step4 = launchSection.match(/^4\. [\s\S]*?(?=\n\n|\n[A-Z])/m)?.[0];
  if (!step4 || !step4.includes("Start a new agent session")) {
    throw new Failure("FAIL: step 4 of orchestrate's Launch section no longer contains \"Start a new agent session\"; update this contract to the skill's wording");
  }
  const checkSection = skill.slice(skill.indexOf("## Check in"));
  const checkIn = checkSection.split("\n\n")[1];
  if (!checkIn) throw new Failure("FAIL: orchestrate's Check in section has no opening paragraph");
  return { launch: step4.trim(), checkIn: checkIn.trim() };
}

function toolCalls(session: string): { name: string; args: any }[] {
  return entries(session).flatMap((e) =>
    e.type === "message" && e.message.role === "assistant"
      ? (e.message.content ?? []).filter((c: any) => c.type === "toolCall").map((c: any) => ({ name: c.name, args: c.arguments }))
      : [],
  );
}

function bashCommands(session: string): string[] {
  return toolCalls(session)
    .filter((c) => c.name === "bash")
    .map((c) => String(c.args?.command ?? ""));
}

function spend(session: string): number {
  return entries(session).reduce((sum, e) => sum + (e.type === "message" && e.message.role === "assistant" ? e.message.usage?.cost?.total ?? 0 : 0), 0);
}

function assistantModels(session: string): string[] {
  return [...new Set(entries(session).flatMap((e) => (e.type === "message" && e.message.role === "assistant" ? [`${e.message.provider}/${e.message.model}`] : [])))];
}

/** Opens a run and its orchestrator; the run is closed here if either fails, so nothing is left behind. */
async function openRun(): Promise<{ run: Run; orchName: string; orchSession: string; orchFolder: string }> {
  const { provider, model } = configuredModel();
  const run = new Run({
    extensions: [SCRIPTED_PROVIDER, BRIDGE_EXTENSION, RPIV_DIALOG, SUBAGENTS, MODEL_ALIASES_EXTENSION],
    settings: { skills: [ORCHESTRATE_SKILL, USER_SKILLS] },
  });
  try {
    await run.open();
    return startOrchestrator(run, provider, model);
  } catch (error) {
    run.close();
    throw error;
  }
}

function startOrchestrator(run: Run, provider: string, model: string) {
  // The alias file is configuration, read here; credentials come from the environment only.
  const aliases = join(AGENT, "model-aliases.json");
  if (existsSync(aliases)) copyFileSync(aliases, join(run.agentDir, "model-aliases.json"));
  const orchFolder = run.folder("project");
  const orchName = "orchestrator";
  const orch = run.startPi(orchName, orchFolder, {}, ["--provider", provider, "--model", model]);
  return { run, orchName, orchSession: orch.agent_session!.value!, orchFolder };
}

function modelCheck(orchSession: string): void {
  const { provider, model } = configuredModel();
  const used = assistantModels(orchSession);
  check(used.length > 0 && used.every((m) => m === `${provider}/${model}`), `the orchestrator ran on the configured default model ${provider}/${model}`, used);
}

const cases: Record<string, () => Promise<number>> = {
  async orchestrate() {
    const { run, orchName, orchSession, orchFolder } = await openRun();
    try {
      const { launch, checkIn } = orchestrateWording();
      const ticket = "doodledood/pi-plugins#900";
      const runId = `orch-${Date.now().toString(36)}-r1`;
      run.prompt(
        orchName,
        [
          `You are the orchestrate skill's orchestrator, at its Launch step for one Ticket. This project is ${orchFolder}.`,
          "Follow these two passages from the skill:",
          launch,
          checkIn,
          `The Ticket is ${ticket} and its run ID is ${runId}; its claim and launch facts are already written. Launch it now.`,
        ].join("\n\n"),
      );
      const started = await waitFor("a started session", () => run.agents().find((a) => a.name && a.name !== orchName && a.agent === "pi"), 300_000);
      const calls = toolCalls(orchSession);
      check(calls.some((c) => c.name === "start_agent_session"), "orchestrate: the run's session started through start_agent_session", calls.map((c) => c.name));
      check(!calls.some((c) => c.name === "subagent"), "orchestrate: not through the subagent tool");
      const workerSession = await waitFor("the worker's session file", () => {
        const path = run.agent(started.name!)?.agent_session?.value;
        return path && existsSync(path) ? path : undefined;
      });
      const first = await waitFor("the worker's first user message", () => transcript(workerSession).find((m) => m.role === "user"));
      check(first.text === `Invoke the run-ticket skill with: "${ticket} --run ${runId}"`, "orchestrate: the worker's first user message is exactly the run-ticket line", first.text);
      await waitFor("the wake-up when the worker's turn ends", () => wakeups(orchSession).find((w) => w.includes(`\`${started.name}\``) && w.includes("finished a turn")), 60_000);
      const afterWake = await waitFor("the orchestrator's turn after the wake-up", () => {
        const lines = transcript(orchSession);
        const at = lines.findIndex((m) => m.role === "custom" && m.text.includes("finished a turn"));
        return at >= 0 ? lines.slice(at + 1).find((m) => m.role === "assistant" && m.text.trim()) : undefined;
      }, 300_000);
      const after = (() => {
        const all = entries(orchSession);
        const at = all.findIndex((e) => e.type === "custom_message" && JSON.stringify(e.content).includes("finished a turn"));
        return JSON.stringify(all.slice(at + 1).filter((e) => e.type === "message" && e.message.role === "assistant"));
      })();
      check(after.includes(runId) || after.includes(started.name!), "orchestrate: the turn after the wake-up names that run (its run ID or its session)", afterWake.text);
      await waitFor("the orchestrator to settle", () => (["idle", "done"].includes(run.status(orchName) ?? "") ? true : undefined), 300_000);

      const before = bashCommands(orchSession).length;
      run.prompt(orchName, "Check in now, as the orchestrate skill's Check in section says, and tell me whether the run's session is alive.");
      await waitFor("the check-in to finish", async () => {
        const status = run.status(orchName);
        return bashCommands(orchSession).length > before && (status === "idle" || status === "done") ? true : undefined;
      }, 300_000);
      const checkCommands = bashCommands(orchSession).slice(before);
      check(checkCommands.some((c) => /herdr (agent (get|list)|api snapshot)/.test(c) && (c.includes(started.name!) || /agent list|api snapshot/.test(c))), "orchestrate: the check-in read the worker's state from Herdr", checkCommands);
      const reply = transcript(orchSession).filter((m) => m.role === "assistant" && m.text.trim()).at(-1)!.text;
      const herdrStatus = run.status(started.name!);
      check(herdrStatus !== undefined, "orchestrate: Herdr shows the worker live at check-in", herdrStatus);
      const saysAlive = /\b(alive|running|live|idle|up)\b/i.test(reply);
      const saysDead = /\bnot (alive|running|live|up)\b|\b(exited|gone|dead|crashed|stopped)\b/i.test(reply);
      check(saysAlive && !saysDead, `orchestrate: its report of the worker as alive matches Herdr (${herdrStatus})`, reply);
      modelCheck(orchSession);
      return spend(orchSession);
    } finally {
      run.close();
    }
  },

  async joke() {
    const { run, orchName, orchSession } = await openRun();
    try {
      const folder = run.folder("jokes");
      run.prompt(orchName, `please create 2 sessions in ${folder} that tell me a joke`);
      await waitFor("two started sessions", () => (run.agents().filter((a) => a.name !== orchName && a.agent === "pi").length >= 2 ? true : undefined), 300_000);
      const calls = toolCalls(orchSession);
      check(calls.filter((c) => c.name === "start_agent_session").length >= 2, "joke: two sessions started through start_agent_session", calls.map((c) => c.name));
      check(!calls.some((c) => c.name === "subagent"), "joke: the subagent tool was never called");
      const workers = run.agents().filter((a) => a.name !== orchName && a.agent === "pi");
      check(workers.every((w) => w.cwd === folder), "joke: both sessions work in that folder", workers.map((w) => w.cwd));
      const firsts = await waitFor("both workers' first prompts", () => {
        const texts = workers.map((w) => {
          const path = run.agent(w.name!)?.agent_session?.value;
          return path && existsSync(path) ? transcript(path).find((m) => m.role === "user")?.text : undefined;
        });
        return texts.every(Boolean) ? (texts as string[]) : undefined;
      });
      check(firsts.every((t) => /joke/i.test(t)), "joke: both workers' first prompt asks for a joke", firsts);
      const asker = await waitFor("the worker that asks which topic", () =>
        workers.find((w) => {
          const path = run.agent(w.name!)?.agent_session?.value;
          return path && existsSync(path) && toolCalls(path).some((c) => c.name === "ask_user_question");
        }),
      );
      await waitFor("the blocked wake-up", () => wakeups(orchSession).find((w) => w.includes(`\`${asker.name}\``) && w.includes("waiting at a question")), 60_000);
      const askerSession = run.agent(asker.name!)!.agent_session!.value!;
      const result = await waitFor("the asker's answered question", () => transcript(askerSession).find((m) => m.role === "toolResult" && /Software|Cooking/.test(m.text)), 300_000);
      check(/"Software"|"Cooking"/.test(result.text), "joke: the orchestrator answered the routine question through Herdr, and the worker's tool result carries an offered label", result.text);
      check(bashCommands(orchSession).some((c) => /herdr (agent send-keys|pane send-text)/.test(c)), "joke: it answered with Herdr's agent commands", bashCommands(orchSession));
      modelCheck(orchSession);
      return spend(orchSession);
    } finally {
      run.close();
    }
  },

  async subagent() {
    const { run, orchName, orchSession } = await openRun();
    try {
      const folder = run.folder("readonly");
      run.prompt(orchName, `Use a background subagent to list the files in ${folder} and report back what it found. Do not do it yourself.`);
      await waitFor("a subagent or session call", () => toolCalls(orchSession).find((c) => c.name === "subagent" || c.name === "start_agent_session"), 300_000);
      await waitFor("the orchestrator to settle", () => (["idle", "done"].includes(run.status(orchName) ?? "") ? true : undefined), 300_000);
      const calls = toolCalls(orchSession);
      check(calls.some((c) => c.name === "subagent"), "subagent: the subagent tool was called", calls.map((c) => c.name));
      check(!calls.some((c) => c.name === "start_agent_session"), "subagent: start_agent_session was not called");
      modelCheck(orchSession);
      return spend(orchSession);
    } finally {
      run.close();
    }
  },
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runsAt = args.indexOf("--runs");
  const runs = runsAt === -1 ? 3 : Number(args[runsAt + 1]);
  const names = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--runs");
  const chosen = names.length ? names : Object.keys(cases);
  for (const name of chosen) if (!cases[name]) throw new Error(`unknown case ${name}; known: ${Object.keys(cases).join(", ")}`);
  let failed = 0;
  let total = 0;
  for (const name of chosen) {
    for (let i = 1; i <= runs; i++) {
      console.log(`# ${name} run ${i} of ${runs}`);
      try {
        const cost = await cases[name]!();
        total += cost;
        console.log(`  spend: $${cost.toFixed(4)}`);
      } catch (error) {
        failed++;
        console.log(error instanceof Failure ? error.message : `FAIL: ${name} crashed: ${error instanceof Error ? error.stack : String(error)}`);
      }
    }
  }
  console.log(`total orchestrator spend: $${total.toFixed(4)}`);
  if (failed) {
    console.log(`${failed} run(s) failed`);
    process.exit(1);
  }
  console.log("all runs passed");
}

// Runs only when executed, never when imported.
if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
