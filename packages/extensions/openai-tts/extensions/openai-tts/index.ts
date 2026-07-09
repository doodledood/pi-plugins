import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type PiExecResult = { stdout?: string; stderr?: string; code?: number; killed?: boolean };
type PiApi = {
  registerTool(tool: Record<string, unknown>): void;
  registerCommand(name: string, command: { description?: string; handler: (args: string, ctx: any) => Promise<void> | void }): void;
  exec(command: string, args: string[], options?: { timeout?: number; signal?: AbortSignal }): Promise<PiExecResult>;
};

type AudioFormat = "mp3" | "wav" | "aac" | "opus" | "flac";

type TtsParams = {
  text: string;
  model?: string;
  voice?: string;
  format?: AudioFormat;
  instructions?: string;
  speed?: number;
};

type TtsConfig = {
  apiKey: string;
  endpoint: string;
  model: string;
  voice: string;
  format: AudioFormat;
  instructions?: string;
  speed?: number;
  requestTimeoutMs: number;
  playbackTimeoutMs?: number;
  maxChars: number;
  maxAudioBytes: number;
};

type SpeakResult = {
  model: string;
  voice: string;
  format: AudioFormat;
  chars: number;
  audioBytes: number;
  player: string;
};

const AUDIO_FORMATS = ["mp3", "wav", "aac", "opus", "flac"] as const;
const DEFAULT_MODEL = "gpt-4o-mini-tts";
const DEFAULT_VOICE = "coral";
const DEFAULT_FORMAT: AudioFormat = "mp3";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONFIGURED_PLAYBACK_TIMEOUT_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_CHARS = 4_000;
const DEFAULT_MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const TtsParamsSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description: "Text to speak aloud on the local machine running Pi. Keep this concise unless the user explicitly asks to read a long passage.",
      minLength: 1,
    },
    model: { type: "string", description: `OpenAI TTS model. Defaults to OPENAI_TTS_MODEL or ${DEFAULT_MODEL}.` },
    voice: { type: "string", description: `OpenAI voice name or custom voice id. Defaults to OPENAI_TTS_VOICE or ${DEFAULT_VOICE}.` },
    format: { type: "string", enum: AUDIO_FORMATS, description: `Audio response format. Defaults to OPENAI_TTS_FORMAT or ${DEFAULT_FORMAT}.` },
    instructions: { type: "string", description: "Optional delivery instructions, such as tone, pace, affect, or pronunciation guidance." },
    speed: { type: "number", description: "Optional speech speed multiplier. OpenAI accepts roughly 0.25 to 4.0.", minimum: 0.25, maximum: 4 },
  },
  required: ["text"],
  additionalProperties: false,
} as const;

export default function openaiTtsExtension(pi: PiApi): void {
  pi.registerTool({
    name: "openai_tts_speak",
    label: "OpenAI TTS",
    description: "Explicit-user-authorized text-to-speech: speak the supplied text aloud via OpenAI only when the user specifically asks for this audio output.",
    promptSnippet: "Explicit-user-authorized OpenAI text-to-speech on the local machine; never self-initiate audio.",
    promptGuidelines: [
      "Use openai_tts_speak only when the latest user instruction explicitly asks for this specific spoken audio, read-aloud, or audible-notification output.",
      "Do not use openai_tts_speak for routine answers, progress updates, completion notices, background-agent status, or proactive alerts unless the user explicitly authorized that exact kind of speech in the current task.",
      "Do not infer consent to speak from an active microphone, meeting context, prior successful tests, or the mere availability of the tool; silence is the safe default.",
      "Keep openai_tts_speak text limited to the user-authorized content; do not speak code blocks, logs, diffs, secrets, or long technical output unless the user explicitly asks for that content aloud.",
      "If openai_tts_speak fails, continue in text and briefly report the failure instead of repeatedly retrying or switching to another audio path.",
    ],
    parameters: TtsParamsSchema,
    async execute(_toolCallId: string, params: TtsParams, signal?: AbortSignal, onUpdate?: (partial: Record<string, unknown>) => void) {
      onUpdate?.({ content: [{ type: "text", text: "Requesting speech audio from OpenAI…" }], details: { stage: "requesting" } });
      const result = await speakWithOpenAI(pi, params, signal, (message, details) => {
        onUpdate?.({ content: [{ type: "text", text: message }], details });
      });
      return {
        content: [{ type: "text", text: `Spoke ${result.chars} character(s) using OpenAI ${result.model}/${result.voice} (${result.format}) via ${result.player}.` }],
        details: result,
      };
    },
  });

  pi.registerCommand("openai-tts", {
    description: "Speak text aloud using OpenAI TTS. Usage: /openai-tts hello world",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) {
        const cfg = loadConfig({ text: "status" }, false);
        const keyStatus = cfg.apiKey ? "configured" : "missing";
        ctx.ui.notify(
          `OpenAI TTS: API key ${keyStatus}; endpoint ${cfg.endpoint}; model ${cfg.model}; voice ${cfg.voice}; format ${cfg.format}. Usage: /openai-tts text to speak`,
          cfg.apiKey ? "info" : "warning",
        );
        return;
      }
      try {
        ctx.ui.notify("OpenAI TTS: requesting speech…", "info");
        const result = await speakWithOpenAI(pi, { text }, ctx.signal, (message) => ctx.ui.notify(message, "info"));
        ctx.ui.notify(`OpenAI TTS: spoke ${result.chars} character(s).`, "info");
      } catch (error) {
        ctx.ui.notify(`OpenAI TTS failed: ${errorMessage(error)}`, "error");
      }
    },
  });
}

async function speakWithOpenAI(
  pi: Pick<PiApi, "exec">,
  params: TtsParams,
  signal?: AbortSignal,
  onProgress?: (message: string, details?: Record<string, unknown>) => void,
): Promise<SpeakResult> {
  const config = loadConfig(params, true);
  const text = params.text.trim();
  if (!text) throw new Error("No text provided to speak.");
  if (text.length > config.maxChars) {
    throw new Error(`Text is ${text.length} characters, above the configured OPENAI_TTS_MAX_CHARS limit of ${config.maxChars}.`);
  }

  const timeout = withTimeoutSignal(signal, config.requestTimeoutMs);
  const format = config.format;
  const tempFile = join(tmpdir(), `pi-openai-tts-${randomUUID()}.${format}`);

  try {
    const body: Record<string, unknown> = {
      model: config.model,
      voice: config.voice,
      input: text,
      response_format: format,
    };
    if (config.instructions) body.instructions = config.instructions;
    if (typeof config.speed === "number") body.speed = config.speed;

    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: timeout.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`OpenAI speech request failed (${response.status} ${response.statusText}): ${truncate(detail.trim(), 800)}`);
    }

    const audio = await readAudioResponse(response, config.maxAudioBytes, timeout.signal);
    await writeFile(tempFile, audio);
    onProgress?.("Playing speech audio locally…", { stage: "playing", audioBytes: audio.byteLength });
    const player = await playAudioFile(pi, tempFile, config.playbackTimeoutMs, signal);

    return {
      model: config.model,
      voice: config.voice,
      format,
      chars: text.length,
      audioBytes: audio.byteLength,
      player,
    };
  } finally {
    timeout.cleanup();
    await rm(tempFile, { force: true }).catch(() => undefined);
  }
}

function loadConfig(params: Partial<TtsParams>, requireKey: boolean): TtsConfig {
  const apiKey = firstNonEmpty(process.env.OPENAI_TTS_API_KEY, process.env.OPENAI_API_KEY);
  if (requireKey && !apiKey) {
    throw new Error("Missing OPENAI_TTS_API_KEY or OPENAI_API_KEY in the Pi process environment.");
  }

  const endpointInput = firstNonEmpty(process.env.OPENAI_TTS_ENDPOINT, process.env.OPENAI_TTS_BASE_URL, "https://api.openai.com")!;
  const format = normalizeFormat(params.format ?? process.env.OPENAI_TTS_FORMAT ?? DEFAULT_FORMAT);
  return {
    apiKey: apiKey ?? "",
    endpoint: normalizeOpenAIEndpoint(endpointInput),
    model: nonEmpty(params.model) ?? firstNonEmpty(process.env.OPENAI_TTS_MODEL, DEFAULT_MODEL)!,
    voice: nonEmpty(params.voice) ?? firstNonEmpty(process.env.OPENAI_TTS_VOICE, DEFAULT_VOICE)!,
    format,
    instructions: nonEmpty(params.instructions) ?? nonEmpty(process.env.OPENAI_TTS_INSTRUCTIONS),
    speed: normalizeOptionalNumber(params.speed ?? process.env.OPENAI_TTS_SPEED, 0.25, 4),
    requestTimeoutMs: normalizeInt(process.env.OPENAI_TTS_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, 1_000, 120_000),
    playbackTimeoutMs: resolvePlaybackTimeoutMs(params),
    maxChars: normalizeInt(process.env.OPENAI_TTS_MAX_CHARS, DEFAULT_MAX_CHARS, 1, 100_000),
    maxAudioBytes: normalizeInt(process.env.OPENAI_TTS_MAX_AUDIO_BYTES, DEFAULT_MAX_AUDIO_BYTES, 1024, 200 * 1024 * 1024),
  };
}

function resolvePlaybackTimeoutMs(_params: Partial<TtsParams>): number | undefined {
  const explicit = normalizeOptionalNumber(process.env.OPENAI_TTS_PLAYBACK_TIMEOUT_MS, 1, MAX_CONFIGURED_PLAYBACK_TIMEOUT_MS);
  return typeof explicit === "number" ? Math.floor(explicit) : undefined;
}

function normalizeOpenAIEndpoint(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/v1/audio/speech")) return trimmed;
  if (trimmed.endsWith("/audio/speech")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/audio/speech`;
  return `${trimmed}/v1/audio/speech`;
}

function normalizeFormat(value: unknown): AudioFormat {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  if ((AUDIO_FORMATS as readonly string[]).includes(candidate)) return candidate as AudioFormat;
  return DEFAULT_FORMAT;
}

function normalizeOptionalNumber(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = nonEmpty(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function withTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  let parentListener: (() => void) | undefined;
  const timeout = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);

  if (parent) {
    if (parent.aborted) {
      controller.abort(parent.reason);
    } else {
      parentListener = () => controller.abort(parent.reason);
      parent.addEventListener("abort", parentListener, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      if (parent && parentListener) parent.removeEventListener("abort", parentListener);
    },
  };
}

async function readAudioResponse(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`OpenAI returned ${contentLength} bytes, above OPENAI_TTS_MAX_AUDIO_BYTES=${maxBytes}.`);
  }

  if (!response.body) {
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error(`OpenAI returned ${arrayBuffer.byteLength} bytes, above OPENAI_TTS_MAX_AUDIO_BYTES=${maxBytes}.`);
    }
    return Buffer.from(arrayBuffer);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("OpenAI TTS request aborted.");
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`OpenAI returned more than OPENAI_TTS_MAX_AUDIO_BYTES=${maxBytes} bytes.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function playAudioFile(pi: Pick<PiApi, "exec">, filePath: string, timeoutMs: number | undefined, signal?: AbortSignal): Promise<string> {
  const candidates = playbackCandidates(filePath);
  const failures: string[] = [];

  for (const candidate of candidates) {
    const result = await pi.exec(candidate.command, candidate.args, { timeout: timeoutMs, signal });
    if (result.code === 0 && !result.killed) return candidate.label;
    if (result.killed) {
      const reason = timeoutMs === undefined ? "was interrupted before it finished" : `timed out after ${timeoutMs}ms`;
      throw new Error(`${candidate.label} playback ${reason}. Set a larger OPENAI_TTS_PLAYBACK_TIMEOUT_MS or leave it unset for uncapped playback.`);
    }
    failures.push(`${candidate.label}: exit=${result.code}${result.stderr ? ` stderr=${truncate(result.stderr.trim(), 180)}` : ""}`);
  }

  throw new Error(`Could not play audio. Install afplay, ffplay, mpv, paplay, or aplay. Attempts: ${failures.join("; ")}`);
}

function playbackCandidates(filePath: string): Array<{ label: string; command: string; args: string[] }> {
  const common = [
    { label: "ffplay", command: "ffplay", args: ["-autoexit", "-nodisp", "-loglevel", "error", filePath] },
    { label: "mpv", command: "mpv", args: ["--really-quiet", filePath] },
  ];

  if (process.platform === "darwin") {
    return [{ label: "afplay", command: "afplay", args: [filePath] }, ...common];
  }

  if (process.platform === "linux") {
    return [...common, { label: "paplay", command: "paplay", args: [filePath] }, { label: "aplay", command: "aplay", args: [filePath] }];
  }

  if (process.platform === "win32") {
    return [...common, { label: "PowerShell default player", command: "powershell.exe", args: ["-NoProfile", "-Command", `Start-Process -Wait -FilePath ${JSON.stringify(filePath)}`] }];
  }

  return common;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
