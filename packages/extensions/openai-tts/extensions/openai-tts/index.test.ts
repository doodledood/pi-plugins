import { existsSync } from "node:fs";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import openaiTtsExtension, { COST_RECORD_TYPE, recordSpeechSpend } from "./index.ts";

type RegisteredTool = {
  name: string;
  description?: string;
  promptSnippet?: string;
  parameters: unknown;
  promptGuidelines?: string[];
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (update: unknown) => void, ctx?: unknown) => Promise<unknown>;
};

type RegisteredCommand = {
  description?: string;
  handler: (args: string, ctx: unknown) => Promise<void> | void;
};

type ExecMock = (command: string, args: string[], options?: { timeout?: number; signal?: AbortSignal }) => Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>;

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

const defaultExec: ExecMock = async () => ({ code: 0, stdout: "", stderr: "", killed: false });

function registerWith(exec: ExecMock = defaultExec) {
  const tools: RegisteredTool[] = [];
  const commands: Array<{ name: string; command: RegisteredCommand }> = [];
  openaiTtsExtension({
    registerTool(tool: unknown) {
      tools.push(tool as RegisteredTool);
    },
    registerCommand(name: string, command: RegisteredCommand) {
      commands.push({ name, command });
    },
    exec,
  });
  return { tools, commands };
}

test("registers openai_tts_speak tool and /openai-tts command", () => {
  const { tools, commands } = registerWith();
  assert.deepEqual(tools.map((tool) => tool.name), ["openai_tts_speak"]);
  assert.deepEqual(commands.map((command) => command.name), ["openai-tts"]);
  assert.equal((tools[0]?.parameters as { type?: string }).type, "object");
  assert.match(tools[0]?.description ?? "", /explicit/i);
  assert.match(String((tools[0] as { promptSnippet?: string }).promptSnippet), /never self-initiate audio/i);
  assert.ok(tools[0]?.promptGuidelines?.some((line) => /latest user instruction explicitly asks/.test(line)));
  assert.ok(tools[0]?.promptGuidelines?.some((line) => /routine answers, progress updates, completion notices, background-agent status/.test(line)));
});

test("sends OpenAI speech request, plays temp audio, and cleans it up", async () => {
  process.env.OPENAI_TTS_API_KEY = "test-key";
  process.env.OPENAI_TTS_ENDPOINT = "https://api.openai.com";
  process.env.OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
  process.env.OPENAI_TTS_VOICE = "coral";

  const fetchCalls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (url, init) => {
    assert.ok(init);
    fetchCalls.push({
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return new Response(Buffer.from("fake audio"), {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    });
  };

  const playedFiles: string[] = [];
  const { tools } = registerWith(async (command, args, options) => {
    assert.equal(command, process.platform === "darwin" ? "afplay" : "ffplay");
    assert.equal(options?.timeout, undefined);
    const file = args[args.length - 1];
    assert.equal(typeof file, "string");
    playedFiles.push(file as string);
    assert.ok(existsSync(file as string));
    return { code: 0, stdout: "", stderr: "", killed: false };
  });

  const updates: unknown[] = [];
  const result = await tools[0]!.execute(
    "tool_1",
    { text: "Hello from test.", instructions: "Speak warmly.", speed: 1.2 },
    undefined,
    (update) => updates.push(update),
    {},
  ) as { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0]!.url, "https://api.openai.com/v1/audio/speech");
  assert.equal(fetchCalls[0]!.headers.authorization, "Bearer test-key");
  assert.deepEqual(fetchCalls[0]!.body, {
    model: "gpt-4o-mini-tts",
    voice: "coral",
    input: "Hello from test.",
    response_format: "mp3",
    instructions: "Speak warmly.",
    speed: 1.2,
  });
  assert.equal(updates.length, 2);
  assert.equal(result.details.player, process.platform === "darwin" ? "afplay" : "ffplay");
  assert.equal(result.details.audioBytes, Buffer.byteLength("fake audio"));
  assert.equal(playedFiles.length, 1);
  assert.equal(existsSync(playedFiles[0]!), false);
});

test("honors explicit playback timeout when configured", async () => {
  process.env.OPENAI_TTS_API_KEY = "test-key";
  process.env.OPENAI_TTS_PLAYBACK_TIMEOUT_MS = "123456";
  globalThis.fetch = async () => new Response(Buffer.from("fake audio"), { status: 200 });

  let observedTimeout: number | undefined;
  const { tools } = registerWith(async (_command, _args, options) => {
    observedTimeout = options?.timeout;
    return { code: 0, stdout: "", stderr: "", killed: false };
  });

  await tools[0]!.execute("tool_1", { text: "Hello." });
  assert.equal(observedTimeout, 123456);
});

test("throws actionable error when API key is missing", async () => {
  delete process.env.OPENAI_TTS_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const { tools } = registerWith();
  await assert.rejects(
    () => tools[0]!.execute("tool_1", { text: "Hello" }),
    /Missing OPENAI_TTS_API_KEY or OPENAI_API_KEY/,
  );
});

test("reports interrupted playback without misleading player fallback", async () => {
  process.env.OPENAI_TTS_API_KEY = "test-key";
  globalThis.fetch = async () => new Response(Buffer.from("fake audio"), { status: 200 });

  const { tools } = registerWith(async () => ({ code: 0, stdout: "", stderr: "", killed: true }));

  await assert.rejects(
    () => tools[0]!.execute("tool_1", { text: "This text starts playing but the local player is interrupted." }),
    /playback was interrupted.*OPENAI_TTS_PLAYBACK_TIMEOUT_MS/,
  );
});

test("enforces configured max text length before network calls", async () => {
  process.env.OPENAI_TTS_API_KEY = "test-key";
  process.env.OPENAI_TTS_MAX_CHARS = "5";
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response(Buffer.from(""));
  };

  const { tools } = registerWith();
  await assert.rejects(
    () => tools[0]!.execute("tool_1", { text: "too long" }),
    /above the configured OPENAI_TTS_MAX_CHARS limit/,
  );
  assert.equal(fetchCalled, false);
});

test("a successful speech call records its usage durably, with a price only when configured", () => {
  const entries: Array<{ customType: string; data: any }> = [];
  const pi = { appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }) };
  const result = { model: "gpt-4o-mini-tts", voice: "coral", format: "mp3" as const, chars: 500_000, audioBytes: 1024, player: "afplay" };

  const savedPrice = process.env.OPENAI_TTS_PRICE_PER_MCHAR;
  try {
    delete process.env.OPENAI_TTS_PRICE_PER_MCHAR;
    recordSpeechSpend(pi, result);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.customType, COST_RECORD_TYPE);
    assert.equal(entries[0]?.data.characters, 500_000);
    assert.equal(entries[0]?.data.voice, "coral");
    assert.match(entries[0]?.data.key, /gpt-4o-mini-tts/);
    assert.equal(entries[0]?.data.priced, false, "no rate configured, so no dollar figure is invented");
    assert.equal(entries[0]?.data.usage.cost.total, 0);

    process.env.OPENAI_TTS_PRICE_PER_MCHAR = "12";
    recordSpeechSpend(pi, result);
    assert.equal(entries.length, 2);
    assert.equal(entries[1]?.data.priced, true);
    // 500k characters at $12 per million characters = $6.
    assert.ok(Math.abs(entries[1]?.data.usage.cost.total - 6) < 1e-9, `got ${entries[1]?.data.usage.cost.total}`);
    assert.notEqual(entries[1]?.data.recordId, entries[0]?.data.recordId, "each call gets its own id");
  } finally {
    if (savedPrice === undefined) delete process.env.OPENAI_TTS_PRICE_PER_MCHAR;
    else process.env.OPENAI_TTS_PRICE_PER_MCHAR = savedPrice;
  }
});

test("recording spend never breaks speech when the session cannot take entries", () => {
  const result = { model: "gpt-4o-mini-tts", voice: "coral", format: "mp3" as const, chars: 10, audioBytes: 8, player: "afplay" };
  assert.doesNotThrow(() => recordSpeechSpend({}, result));
  assert.doesNotThrow(() =>
    recordSpeechSpend(
      {
        appendEntry() {
          throw new Error("session is shutting down");
        },
      },
      result,
    ),
  );
});
