// End-to-end checks for herdr-bridge against the installed Herdr, in a Herdr session of their own.
// Pi runs on a scripted fake provider, so a run spends nothing; it takes a few minutes.
//
//   npm run e2e --workspace @doodledood/pi-herdr-bridge [-- <scenario> ...]
//
// Scenarios: start, real-setup, bridge, wakeups, quiet, reload, answer. With none named, all run.
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WAKEUP_TYPE } from "../messages.ts";
import {
  BRIDGE_EXTENSION,
  Failure,
  HERE,
  RPIV_DIALOG,
  Run,
  SCRIPTED_PROVIDER,
  check,
  entries,
  installedExtensions,
  sleep,
  transcript,
  waitFor,
  wakeups,
} from "./harness.ts";

const SPY = join(HERE, "blocked-spy.ts");
const BASE = [SCRIPTED_PROVIDER, BRIDGE_EXTENSION, RPIV_DIALOG, SPY];

const notBlocked = (run: Run, name: string) => {
  const status = run.status(name);
  return status && status !== "blocked" ? status : undefined;
};

/** The wake-up arrival time from its session entry, in ms. */
function wakeupTimes(session: string, match: (text: string) => boolean): number[] {
  return entries(session)
    .filter((e) => e.type === "custom_message" && e.customType === WAKEUP_TYPE && match(typeof e.content === "string" ? e.content : JSON.stringify(e.content)))
    .map((e) => Date.parse(e.timestamp));
}

/** Runs the backticked `herdr ...` commands a wake-up gives, against this run's session, after substitution. */
function runStep(run: Run, command: string): void {
  const words = command.match(/"[^"]*"|\S+/g)!.map((w) => w.replace(/^"|"$/g, ""));
  if (words[0] !== "herdr") throw new Failure(`FAIL: step is not a herdr command: ${command}`);
  run.herdr(words.slice(1));
}

function stepTemplate(wakeup: string, starts: string): string {
  const line = wakeup.split("\n").find((l) => l.includes(starts));
  if (!line) throw new Failure(`FAIL: the wake-up has no step for "${starts}"\n${wakeup}`);
  return line;
}

function commandsIn(line: string): string[] {
  return [...line.matchAll(/`(herdr [^`]+)`/g)].map((m) => m[1]!);
}

function call(tool: string, args: unknown): string {
  return `CALL ${tool} ${JSON.stringify(args)}`;
}

/** Starts an orchestrator Pi and has it start a worker through the tool; returns both. */
async function orchestrate(run: Run, workerPrompt: string, opts: { worker?: string; folder?: string; orchEnv?: Record<string, string> } = {}) {
  const orchFolder = run.folder(`orch-${opts.worker ?? "worker"}`);
  const orchName = `orch-${(opts.worker ?? "worker").slice(0, 20)}`;
  const orch = run.startPi(orchName, orchFolder, opts.orchEnv);
  const orchSession = orch.agent_session!.value!;
  const folder = opts.folder ?? run.folder(`work-${opts.worker ?? "worker"}`);
  const name = opts.worker ?? "worker";
  run.prompt(orchName, call("start_agent_session", { folder, name, prompt: workerPrompt }));
  const worker = await waitFor(`${name} to appear in Herdr as Pi`, () => {
    const agent = run.agent(name);
    return agent?.agent === "pi" ? agent : undefined;
  }, 120_000);
  await waitFor("the start tool's result in the orchestrator", () => transcript(orchSession).find((m) => m.role === "toolResult" && m.text.includes(`Started Pi session "${name}"`)), 120_000);
  return { orchName, orchSession, worker, folder };
}

const scenarios: Record<string, (run: Run) => Promise<void>> = {
  async start(run) {
    const { orchName, orchSession, worker, folder } = await orchestrate(run, "hello worker");
    check(worker.agent === "pi", "the started pane runs an interactive Pi that Herdr recognizes as kind pi", worker.agent);
    check(worker.cwd === folder, "its working directory is the requested folder", worker.cwd);
    check(worker.name === "worker", "it carries the requested name", worker.name);
    const tabs = run.herdr(["tab", "list", "--workspace", worker.workspace_id]).tabs;
    const workspaces = run.herdr(["workspace", "list"]).workspaces;
    check(workspaces.some((w: any) => w.workspace_id === worker.workspace_id && w.label === folder.split("/").at(-1)), "it sits in a new workspace made for that folder", workspaces);
    check(tabs.some((t: any) => t.tab_id === worker.tab_id), "in its own tab", tabs);
    const workerSession = await waitFor("Herdr to report the worker's Pi session file, written", () => {
      const path = run.agent("worker")?.agent_session?.value;
      return path && existsSync(path) ? path : undefined;
    });
    check(workerSession, "Herdr reports the worker's Pi session file", workerSession);
    const firstUser = await waitFor("the worker's first user message", () => transcript(workerSession!).find((m) => m.role === "user"));
    check(firstUser.text === "hello worker", "the first prompt arrived as the worker's first user message", firstUser.text);
    const result = transcript(orchSession).find((m) => m.role === "toolResult")!.text;
    check(result.includes(`pane ${worker.pane_id}`) && result.includes(workerSession!), "the tool's result names the session's pane and its Pi session file", result);
    check(run.herdr(["agent", "get", "worker"]).agent.pane_id === worker.pane_id, "herdr agent get accepts the handle");
    check(typeof run.herdr(["agent", "read", "worker", "--lines", "5"]) === "string", "herdr agent read accepts the handle");

    const finished = await waitFor("a finished wake-up in the orchestrator", () => wakeups(orchSession).find((w) => w.includes("`worker`") && w.includes("finished a turn")), 30_000);
    check(finished.includes(worker.pane_id), "the finished wake-up names the worker and its pane", finished);
    await waitFor("the orchestrator's turn on the wake-up", () => transcript(orchSession).find((m) => m.role === "assistant" && m.text.startsWith("WOKE:")));
    check(true, "a wake-up arriving while the orchestrator is idle starts an orchestrator turn that responds to it");
    run.herdr(["agent", "prompt", "worker", "second message"]);
    await waitFor("the second finished wake-up", () => wakeups(orchSession).filter((w) => w.includes("finished a turn")).length >= 2 || undefined);
    check(true, "herdr agent prompt accepts the handle, and the next finished turn wakes again");
    await sleep(5_000);
    check(wakeups(orchSession).filter((w) => w.includes("finished a turn")).length === 2, "repeated reports of an unchanged state add no message", wakeups(orchSession));

    // A second session in the same folder reuses the workspace, in a new tab.
    run.prompt(orchName, call("start_agent_session", { folder, name: "worker-two", prompt: "hi" }));
    const second = await waitFor("worker-two", () => run.agent("worker-two"), 120_000);
    check(second.workspace_id === worker.workspace_id && second.tab_id !== worker.tab_id, "a folder that already has a workspace gets a new tab in it", second);
  },
};

Object.assign(scenarios, {
  async "real-setup"(run: Run) {
    const { worker } = await orchestrate(run, "hello real setup", { worker: "realworker" });
    const session = await waitFor("the real-setup worker's session file", () => {
      const path = run.agent("realworker")?.agent_session?.value;
      return path && existsSync(path) ? path : undefined;
    }, 120_000);
    const first = await waitFor("its first user message", () => transcript(session).find((m) => m.role === "user"), 60_000);
    check(first.text === "hello real setup", "the start tool's first prompt arrived as its first user message", first.text);
    await waitFor("it to settle", () => (["idle", "done"].includes(run.status("realworker") ?? "") ? true : undefined), 60_000);
    check(worker.agent === "pi", "Herdr recognizes the worker on the person's real setup as an idle Pi");
  },

  async bridge(run: Run) {
    const spy = join(run.root, "blocked-events.jsonl");
    run.startPi("dlg", run.folder("dlg"), { HERDR_BRIDGE_SPY: spy });
    const spied = () => (existsSync(spy) ? readFileSync(spy, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

    run.prompt("dlg", 'DIALOGS {"kind":"select"}');
    await waitFor("blocked on the select dialog", () => (run.status("dlg") === "blocked" ? true : undefined), 20_000);
    check(true, "while the worker shows a titled select dialog, Herdr reports the pane blocked");
    check(spied().some((e) => e.active === true && e.label === "Pick a topic"), "the blocked report Herdr's integration forwards carries the dialog title as its message", spied());
    check(run.herdrError(["agent", "prompt", "dlg", "typed into a dialog"]) === "agent_blocked", "herdr agent prompt to it is refused as blocked rather than typed into the dialog");
    run.herdr(["agent", "send-keys", "dlg", "enter"]);
    check(await waitFor("unblocked after the select", () => notBlocked(run, "dlg")), "once the select closes, the state is no longer blocked");

    run.prompt("dlg", "ASK_ONE");
    await waitFor("blocked on ask_user_question", () => (run.status("dlg") === "blocked" ? true : undefined), 20_000);
    check(true, "while the worker shows a custom-component dialog of the kind ask_user_question uses, Herdr reports blocked");
    run.herdr(["agent", "send-keys", "dlg", "1"]);
    check(await waitFor("unblocked after the custom dialog", () => notBlocked(run, "dlg")), "once the custom dialog closes, the state is no longer blocked");

    run.prompt("dlg", 'DIALOGS {"kind":"nested"}');
    await waitFor("blocked on the nested dialogs", () => (run.status("dlg") === "blocked" ? true : undefined), 20_000);
    await waitFor("the inner dialog on screen", () => (run.screen("dlg").includes("Inner question") ? true : undefined), 10_000);
    run.herdr(["agent", "send-keys", "dlg", "enter"]);
    await waitFor("the inner dialog gone", () => (run.screen("dlg").includes("Inner question") ? undefined : true), 10_000);
    await sleep(2_000);
    check(run.status("dlg") === "blocked", "with two nested dialogs, the state stays blocked after the inner one closes", run.status("dlg"));
    run.herdr(["agent", "send-keys", "dlg", "enter"]);
    check(await waitFor("unblocked after the outer dialog", () => notBlocked(run, "dlg")), "and is no longer blocked once the outer one closes");
  },

  async wakeups(run: Run) {
    const { orchName, orchSession } = await orchestrate(run, "SLOW 5000", { worker: "slow" });
    run.prompt(orchName, "SLOW 12000");
    const slowDoneAt = await waitFor("the orchestrator's own slow turn to end", () => transcript(orchSession).findIndex((m) => m.role === "assistant" && m.text.startsWith("SLOW DONE")) + 1 || undefined, 40_000);
    await waitFor("the finished wake-up for slow", () => wakeups(orchSession).find((w) => w.includes("`slow`") && w.includes("finished a turn")), 30_000);
    const lines = transcript(orchSession);
    const wakeAt = lines.findIndex((m) => m.role === "custom" && m.text.includes("`slow`") && m.text.includes("finished a turn")) + 1;
    check(wakeAt > slowDoneAt, "a wake-up arriving mid-turn is delivered after the orchestrator's turn ends, not into it", lines.map((m) => m.role));
    check(lines.some((m) => m.role === "assistant" && m.text === "SLOW DONE after 12000 ms"), "the orchestrator's mid-turn work was not aborted");
    await waitFor("the orchestrator's turn on the delayed wake-up", () => transcript(orchSession).slice(wakeAt).find((m) => m.role === "assistant" && m.text.startsWith("WOKE:")));
    check(true, "the delayed wake-up then starts its own turn");

    run.prompt(orchName, call("start_agent_session", { folder: run.folder("asker"), name: "asker", prompt: "ASK_ONE" }));
    const blocked = await waitFor("the blocked wake-up for asker", () => wakeups(orchSession).find((w) => w.includes("`asker`") && w.includes("waiting at a question")), 60_000);
    check(blocked.includes("Which joke topic should I use?") && blocked.includes("Software") && blocked.includes("Cooking"), "the blocked wake-up names the worker and carries its question and options", blocked);

    run.startPi("loner", run.folder("loner"));
    run.prompt("loner", "hello from a session nobody started through the tool");
    await waitFor("loner to finish", () => (["idle", "done"].includes(run.status("loner") ?? "") ? true : undefined));
    await sleep(6_000);
    check(!wakeups(orchSession).some((w) => w.includes("`loner`")), "a session the orchestrator did not start adds no wake-up");

    const slowPane = run.agent("slow")!.pane_id;
    const closedAt = Date.now();
    run.herdr(["pane", "close", slowPane]);
    await waitFor("the gone wake-up", () => wakeups(orchSession).find((w) => w.includes("`slow`") && w.includes("has exited")), 30_000);
    const [arrived] = wakeupTimes(orchSession, (t) => t.includes("`slow`") && t.includes("has exited"));
    check(arrived! - closedAt <= 30_000, `the exit wake-up arrived within 30 s of the exit (${arrived! - closedAt} ms)`);
    check(wakeups(orchSession).filter((w) => w.includes("`slow`") && w.includes("has exited")).length === 1, "the exit is reported once");
  },

  async quiet(run: Run) {
    const { orchSession } = await orchestrate(run, "SLOW 27000", { worker: "plodder", orchEnv: { HERDR_BRIDGE_QUIET_INTERVAL_MS: "8000" } });
    await waitFor("the finished wake-up after the quiet ones", () => wakeups(orchSession).find((w) => w.includes("`plodder`") && w.includes("finished a turn")), 60_000);
    const quiet = wakeups(orchSession).filter((w) => w.includes("`plodder`") && w.includes("with no change"));
    check(quiet.length >= 2 && quiet.length <= 3, `one still-working wake-up per quiet interval while it stays working (${quiet.length} over ~27 s at 8 s)`, quiet);
    await sleep(12_000);
    check(wakeups(orchSession).filter((w) => w.includes("`plodder`") && w.includes("with no change")).length === quiet.length, "none once it changed state");
  },

  async reload(run: Run) {
    const { orchName, orchSession } = await orchestrate(run, "SLOW 15000", { worker: "steady" });
    run.herdr(["agent", "prompt", orchName, "/reload"]);
    await sleep(3_000);
    await waitFor("steady's finished wake-up after the reload", () => wakeups(orchSession).find((w) => w.includes("`steady`") && w.includes("finished a turn")), 45_000);
    check(true, "after a reload, a worker started before it still produces a wake-up on its next state change");

    run.prompt(orchName, call("start_agent_session", { folder: run.folder("later"), name: "later", prompt: "SLOW 40000" }));
    await waitFor("later started", () => run.agent("later"), 120_000);
    run.prompt(orchName, call("start_agent_session", { folder: run.folder("quitter"), name: "quitter", prompt: "hi" }));
    await waitFor("quitter started", () => run.agent("quitter"), 120_000);
    await waitFor("both start results", () => transcript(orchSession).filter((m) => m.role === "toolResult" && m.text.startsWith("Started")).length >= 3 || undefined, 60_000);
    const orchPane = run.agent(orchName)!.pane_id;
    run.herdr(["agent", "send-keys", orchName, "ctrl+d"]);
    await waitFor("the orchestrator's Pi to exit", () => (run.agent(orchName) ? undefined : true), 20_000);
    run.herdr(["pane", "close", run.agent("quitter")!.pane_id]);
    await sleep(3_000);
    run.startPiIn(orchName, orchPane, ["--session", orchSession]);
    await waitFor("quitter reported gone after the resume", () => wakeups(orchSession).find((w) => w.includes("`quitter`") && w.includes("has exited")), 30_000);
    check(true, "a worker that exited while the orchestrator was down is reported as gone after the resume");
    await waitFor("later's finished wake-up after the resume", () => wakeups(orchSession).find((w) => w.includes("`later`") && w.includes("finished a turn")), 60_000);
    check(true, "after a resume in a new Pi process, a worker started before still produces a wake-up on its next state change");
    await sleep(5_000);
    check(wakeups(orchSession).filter((w) => w.includes("`quitter`")).length === 1, "the gone report is not repeated");
  },

  async answer(run: Run) {
    const cases = [
      { worker: "pick", prompt: "ASK_ONE", expect: ["Software"] },
      { worker: "freetext", prompt: "ASK_ONE", expect: ["a custom answer from the orchestrator"] },
      { worker: "twoq", prompt: "ASK_TWO", expect: ["Software", "Story"] },
    ];
    let orchName = "";
    let orchSession = "";
    for (const c of cases) {
      if (!orchName) {
        ({ orchName, orchSession } = await orchestrate(run, c.prompt, { worker: c.worker }));
      } else {
        run.prompt(orchName, call("start_agent_session", { folder: run.folder(c.worker), name: c.worker, prompt: c.prompt }));
      }
      const wakeup = await waitFor(`the blocked wake-up for ${c.worker}`, () => wakeups(orchSession).find((w) => w.includes(`\`${c.worker}\``) && w.includes("waiting at a question")), 90_000);
      check(wakeup.includes("Which joke topic should I use?") && wakeup.includes("1. Software") && wakeup.includes("2. Cooking"), `${c.worker}: the wake-up carries the question and every option label`, wakeup);
      check(wakeup.includes("Bring a call that needs the person to them"), `${c.worker}: it says to bring a call that needs the person to them`);
      const numbered = commandsIn(stepTemplate(wakeup, "numbered option N"))[0]!;
      if (c.worker === "pick") {
        runStep(run, numbered.replace(/ N$/, " 1"));
      } else if (c.worker === "freetext") {
        const typeRow = wakeup.match(/(\d)\. Type something\./)![1]!;
        const [digit, text, enter] = commandsIn(stepTemplate(wakeup, "your own words"));
        runStep(run, digit!.replace(/ N$/, ` ${typeRow}`));
        await sleep(500);
        runStep(run, text!.replace("<your answer>", "a custom answer from the orchestrator"));
        await sleep(300);
        runStep(run, enter!);
      } else {
        check(wakeup.includes("Several questions show as tabs"), "twoq: the steps say how to answer several questions");
        runStep(run, numbered.replace(/ N$/, " 1"));
        await sleep(800);
        runStep(run, numbered.replace(/ N$/, " 2"));
        await sleep(800);
        const submit = stepTemplate(wakeup, "Submit tab").match(/send `(enter)`/)![1]!;
        runStep(run, `herdr agent send-keys ${c.worker} ${submit}`);
      }
      const session = run.agent(c.worker)!.agent_session!.value!;
      const result = await waitFor(`${c.worker}'s ask_user_question result`, () => transcript(session).find((m) => m.role === "toolResult"), 30_000);
      for (const want of c.expect) check(result.text.includes(want), `${c.worker}: the worker's tool result carries "${want}"`, result.text);
      check(await waitFor(`${c.worker} unblocked`, () => notBlocked(run, c.worker)), `${c.worker}: the dialog closed`);
      await waitFor(`${c.worker}'s run to continue`, () => transcript(session).find((m) => m.role === "assistant" && m.text.startsWith("TOOL RESULT:")), 20_000);
      check(true, `${c.worker}: the worker's run continued`);
    }
  },
});

async function main(): Promise<void> {
  const names = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const chosen = names.length ? names : Object.keys(scenarios);
  for (const name of chosen) if (!scenarios[name]) throw new Error(`unknown scenario ${name}; known: ${Object.keys(scenarios).join(", ")}`);
  let failed = 0;
  for (const name of chosen) {
    const extensions = name === "real-setup" ? [...installedExtensions(), SCRIPTED_PROVIDER, BRIDGE_EXTENSION, SPY] : BASE;
    const run = new Run({ extensions });
    console.log(`# ${name} (herdr session ${run.id})`);
    try {
      await run.open();
      await scenarios[name]!(run);
    } catch (error) {
      failed++;
      console.log(error instanceof Failure ? error.message : `FAIL: ${name} crashed: ${error instanceof Error ? error.stack : String(error)}`);
      try {
        for (const agent of run.agents()) {
          console.log(`  agent ${agent.name} ${agent.agent_status} ${agent.pane_id}`);
          const session = agent.agent_session?.value;
          if (session) for (const m of transcript(session).slice(-6)) console.log(`    [${m.role}${m.customType ? `:${m.customType}` : ""}] ${m.text.slice(0, 300).replace(/\n/g, " / ")}`);
        }
      } catch {}
    } finally {
      run.close();
    }
  }
  if (failed) {
    console.log(`${failed} scenario(s) failed`);
    process.exit(1);
  }
  console.log("all scenarios passed");
}

// Runs only when executed, never when imported.
if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
