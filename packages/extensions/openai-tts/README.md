# openai-tts

OpenAI Speech API text-to-speech for Pi. Adds a model-callable `openai_tts_speak` tool and a manual `/openai-tts` command that synthesize text with OpenAI and play the returned audio on the machine running Pi.

## Install

From a local clone:

```bash
pi install /path/to/pi-plugins/packages/extensions/openai-tts
```

From the Git repo with a package filter, add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@main",
      "extensions": ["packages/extensions/openai-tts/extensions/openai-tts/index.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

If you install the root bundle instead, this extension is included with the rest of this repo's curated resources:

```bash
pi install git:github.com/doodledood/pi-plugins@main
```

## Configuration

The extension reads configuration from environment variables in the process that starts Pi. Do not commit API keys to this repo or to setup templates.

| Variable | Default | Description |
| --- | --- | --- |
| `OPENAI_TTS_API_KEY` | falls back to `OPENAI_API_KEY` | OpenAI API key used for speech synthesis. |
| `OPENAI_TTS_ENDPOINT` | `https://api.openai.com` | Base URL or full `/v1/audio/speech` endpoint. |
| `OPENAI_TTS_BASE_URL` | unset | Alias for the endpoint base URL when `OPENAI_TTS_ENDPOINT` is unset. |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | OpenAI text-to-speech model. |
| `OPENAI_TTS_VOICE` | `coral` | OpenAI built-in voice name or custom voice id. |
| `OPENAI_TTS_FORMAT` | `mp3` | Audio format: `mp3`, `wav`, `aac`, `opus`, or `flac`. |
| `OPENAI_TTS_INSTRUCTIONS` | unset | Optional delivery instructions for tone, pace, pronunciation, or affect. |
| `OPENAI_TTS_SPEED` | unset | Optional speed multiplier, clamped to `0.25`–`4`. |
| `OPENAI_TTS_MAX_CHARS` | `4000` | Max input characters per tool/command call. |
| `OPENAI_TTS_MAX_AUDIO_BYTES` | `26214400` | Max downloaded audio response size. |
| `OPENAI_TTS_TIMEOUT_MS` | `30000` | OpenAI request timeout in milliseconds. |
| `OPENAI_TTS_PLAYBACK_TIMEOUT_MS` | unset | Optional local playback timeout in milliseconds. Leave unset for uncapped playback so long audio is not cut off; use Pi/tool abort if playback hangs. |
| `OPENAI_TTS_PRICE_PER_MCHAR` | unset | Price in USD per million characters. Set it to have speech spend counted in dollars (see **Cost accounting**). |

## Cost accounting

Each successful call appends one `pi-cost-record` entry to the session, recording
the characters spoken plus the model and voice. Speech is a paid call with no pi
session of its own, so without this record its spend is invisible to every cost
surface; the `simple-statusline` footer and `/cost` read these records into the
session-tree total.

OpenAI bills speech **per character** while pi prices tokens, so the dollar
figure only appears once you set `OPENAI_TTS_PRICE_PER_MCHAR` to the rate for
your model. Until then the record carries characters with no invented price. A
failed call records nothing, and the record never contains the spoken text.

These are custom entries: they live in the session file, so they last exactly as
long as that session does, and they are excluded from LLM context.

Example:

```bash
# Set OPENAI_API_KEY or OPENAI_TTS_API_KEY in the environment before launching Pi.
export OPENAI_TTS_VOICE=coral
export OPENAI_TTS_MODEL=gpt-4o-mini-tts
pi
```

## Usage

Ask Pi to use the tool when you want spoken output:

```text
Use openai_tts_speak to say "The build is complete."
```

Manual command:

```text
/openai-tts The OpenAI text-to-speech extension is working.
```

The tool returns a short text result to the model and plays the audio locally. It writes the audio to a temporary file and deletes it after playback.

## Playback requirements

Playback happens on the machine running Pi. The extension tries these players:

- macOS: `afplay`, then `ffplay`, then `mpv`
- Linux: `ffplay`, `mpv`, `paplay`, then `aplay`
- Windows: `ffplay`, `mpv`, then PowerShell `Start-Process -Wait`

Install `ffmpeg` if your platform lacks a native player for the chosen audio format.

## Safety notes

- The tool guidance tells the model to use `openai_tts_speak` only when the latest user instruction explicitly asks for that specific spoken audio, read-aloud behavior, or audible notification.
- The model is told not to self-initiate audio for routine answers, progress updates, completion notices, background-agent status, proactive alerts, meetings, or the mere availability of the tool.
- The guidance asks the model not to speak code blocks, logs, diffs, secrets, or long technical output unless explicitly requested.
- Failures are surfaced as actionable errors; the model should continue in text instead of repeatedly retrying or switching to another audio path.
