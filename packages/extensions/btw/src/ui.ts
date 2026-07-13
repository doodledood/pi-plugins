import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  ToolExecutionComponent,
  type AgentSession,
  type AgentSessionEvent,
  type Theme,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type EditorTheme,
  type Focusable,
  type OverlayOptions,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ScreenBounds } from "./mouse.ts";

export type OverlayPhase = "opening" | "ready" | "closing";

export const BTW_OVERLAY_OPTIONS = {
  anchor: "right-center",
  width: "48%",
  minWidth: 52,
  maxHeight: "94%",
  margin: { top: 1, right: 1, bottom: 1 },
} satisfies OverlayOptions;

export interface BtwOverlayCallbacks {
  onSubmit(text: string): void;
  onMain(): void;
  onClose(): void;
  onAbort(): void;
  onDispose?(): void;
}

type TranscriptItem = {
  component: Component;
  spacing: boolean;
  estimatedBytes: number;
};

const MAX_TRANSCRIPT_ITEMS = 160;
const MAX_TRANSCRIPT_ESTIMATED_BYTES = 256_000;
const MAX_TRANSCRIPT_ITEM_BYTES = 64_000;
const MAX_TOOL_FIELD_BYTES = 24_000;
const MAX_ASSISTANT_CONTENT_BYTES = 56_000;
const MAX_TOOL_RESULT_FIELD_BYTES = 16_000;
const MAX_TOOL_RESULT_BYTES = 36_000;
const MAX_PROJECTED_LINES = 1_200;
const MAX_PROJECTED_BYTES = 160_000;
const TRANSCRIPT_OMISSION_MARKER = "… older BTW transcript omitted; full child session retained …";
const ITEM_OMISSION_MARKER = "… older projected content omitted …";

function estimateBytes(value: unknown): number {
  try {
    return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    return 1_024;
  }
}

function utf8BytesAt(text: string, index: number): { bytes: number; units: number } {
  const first = text.charCodeAt(index);
  if (first >= 0xd800 && first <= 0xdbff && index + 1 < text.length) {
    const second = text.charCodeAt(index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) return { bytes: 4, units: 2 };
  }
  if (first <= 0x7f) return { bytes: 1, units: 1 };
  if (first <= 0x7ff) return { bytes: 2, units: 1 };
  return { bytes: 3, units: 1 };
}

function utf8Tail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let used = 0;
  let start = text.length;
  while (start > 0) {
    let candidate = start - 1;
    const last = text.charCodeAt(candidate);
    if (last >= 0xdc00 && last <= 0xdfff && candidate > 0) {
      const previous = text.charCodeAt(candidate - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) candidate -= 1;
    }
    const { bytes } = utf8BytesAt(text, candidate);
    if (used + bytes > maxBytes) break;
    used += bytes;
    start = candidate;
  }
  return text.slice(start);
}

function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let used = 0;
  let end = 0;
  while (end < text.length) {
    const { bytes, units } = utf8BytesAt(text, end);
    if (used + bytes > maxBytes) break;
    used += bytes;
    end += units;
  }
  return text.slice(0, end);
}

export function boundedText(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const marker = `${ITEM_OMISSION_MARKER}\n`;
  const markerBytes = Buffer.byteLength(marker);
  if (markerBytes >= maxBytes) return utf8Prefix(marker, maxBytes);
  return marker + utf8Tail(text, maxBytes - markerBytes);
}

function boundedValue(value: unknown, maxBytes: number): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    return { projection: boundedText(String(value), Math.max(0, Math.floor((maxBytes - 32) / 6))) };
  }
  if (Buffer.byteLength(serialized) <= maxBytes) return value;
  // JSON string escaping can expand a retained code unit to six bytes. Reserve
  // wrapper overhead and use that worst case so the projection itself is hard-bounded.
  return { projection: boundedText(serialized, Math.max(0, Math.floor((maxBytes - 32) / 6))) };
}

function projectArgumentsRecord(
  value: unknown,
  maxBytes = MAX_TOOL_FIELD_BYTES,
): { value: Record<string, unknown>; omitted: boolean } {
  const projected = boundedValue(value, maxBytes);
  const omitted = projected !== value;
  if (typeof projected === "object" && projected !== null && !Array.isArray(projected)) {
    return { value: Object.fromEntries(Object.entries(projected)), omitted };
  }
  return { value: { projection: projected }, omitted };
}

type TailProjection<T> = { block: T; omitted: boolean };

type RetainedTail<T> = { blocks: T[]; omitted: boolean };

/** Retain newest projected blocks within a serialized byte budget. */
function retainProjectedTail<S, T>(
  sources: readonly S[],
  byteBudget: number,
  markerBytes: number,
  initialBytes: number,
  project: (source: S, maxFieldBytes?: number) => TailProjection<T>,
  initiallyOmitted = false,
): RetainedTail<T> {
  const reverse: T[] = [];
  let encodedBytes = initialBytes;
  let omitted = initiallyOmitted;

  for (let index = sources.length - 1; index >= 0; index -= 1) {
    let projection = project(sources[index]!);
    let blockBytes = estimateBytes(projection.block);
    const reserveMarker = index > 0 || omitted || projection.omitted;
    const separatorBytes = reverse.length > 0 ? 1 : 0;
    const markerReserve = reserveMarker ? markerBytes + 1 : 0;

    if (encodedBytes + separatorBytes + blockBytes + markerReserve > byteBudget) {
      projection = project(
        sources[index]!,
        Math.max(0, Math.floor((byteBudget - encodedBytes - markerBytes - 64) / 6)),
      );
      blockBytes = estimateBytes(projection.block);
      if (encodedBytes + separatorBytes + blockBytes + markerBytes + 1 > byteBudget) {
        omitted = true;
        break;
      }
    }

    reverse.push(projection.block);
    encodedBytes += separatorBytes + blockBytes;
    omitted ||= projection.omitted;
  }

  if (reverse.length < sources.length) omitted = true;
  return { blocks: reverse.reverse(), omitted };
}

type AssistantBlockProjection = TailProjection<AssistantMessage["content"][number]>;

function projectAssistantBlock(
  block: AssistantMessage["content"][number],
  maxFieldBytes = MAX_TOOL_FIELD_BYTES,
): AssistantBlockProjection {
  if (block.type === "text") {
    const text = boundedText(block.text, maxFieldBytes);
    return {
      block: { type: "text", text },
      omitted: text !== block.text || Boolean(block.textSignature),
    };
  }
  if (block.type === "thinking") {
    const thinking = boundedText(block.thinking, maxFieldBytes);
    return {
      block: {
        type: "thinking",
        thinking,
        ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
      },
      omitted: thinking !== block.thinking || Boolean(block.thinkingSignature),
    };
  }
  const argumentsProjection = projectArgumentsRecord(block.arguments, maxFieldBytes);
  return {
    block: {
      type: "toolCall",
      id: block.id,
      name: block.name,
      arguments: argumentsProjection.value,
    },
    omitted: argumentsProjection.omitted || Boolean(block.thoughtSignature),
  };
}

export function projectAssistantMessage(message: AssistantMessage): AssistantMessage {
  const markerBlock: AssistantMessage["content"][number] = {
    type: "text",
    text: ITEM_OMISSION_MARKER,
  };
  const markerBytes = estimateBytes(markerBlock);
  const retained = retainProjectedTail(
    message.content,
    MAX_ASSISTANT_CONTENT_BYTES,
    markerBytes,
    2, // JSON array brackets
    projectAssistantBlock,
  );
  const content = retained.blocks;
  if (retained.omitted) content.unshift(markerBlock);
  return {
    role: "assistant",
    content,
    api: message.api,
    provider: message.provider,
    model: message.model,
    usage: message.usage,
    stopReason: message.stopReason,
    ...(message.errorMessage
      ? { errorMessage: boundedText(message.errorMessage, 4_000) }
      : {}),
    timestamp: message.timestamp,
  };
}

export function projectToolArguments(value: unknown): unknown {
  return boundedValue(value, MAX_TOOL_FIELD_BYTES);
}

export interface ProjectedToolContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface ProjectedToolResult {
  content: ProjectedToolContent[];
  details?: unknown;
  isError: boolean;
  terminate?: boolean;
}

interface ProjectableToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string; [key: string]: unknown }>;
  details?: unknown;
  isError?: boolean;
  terminate?: boolean;
}

function projectToolBlock(
  block: ProjectableToolResult["content"][number],
  maxFieldBytes = MAX_TOOL_RESULT_FIELD_BYTES,
): { block: ProjectedToolContent; omitted: boolean } {
  if (typeof block.text === "string") {
    const text = boundedText(block.text, maxFieldBytes);
    return { block: { ...block, text }, omitted: text !== block.text };
  }
  if (typeof block.data === "string" && Buffer.byteLength(block.data) > maxFieldBytes) {
    return {
      block: { ...block, data: "", text: "[projected image data omitted]" },
      omitted: true,
    };
  }
  return { block: { ...block }, omitted: false };
}

export function projectToolResult(result: ProjectableToolResult): ProjectedToolResult {
  let projectedDetails = result.details === undefined
    ? undefined
    : boundedValue(result.details, MAX_TOOL_RESULT_FIELD_BYTES);
  let omitted = projectedDetails !== result.details;
  const baseResult = (): ProjectedToolResult => ({
    content: [],
    ...(projectedDetails === undefined ? {} : { details: projectedDetails }),
    isError: result.isError ?? false,
    ...(result.terminate === undefined ? {} : { terminate: result.terminate }),
  });
  if (estimateBytes(baseResult()) > MAX_TOOL_RESULT_BYTES - 1_024) {
    projectedDetails = { projection: ITEM_OMISSION_MARKER };
    omitted = true;
  }

  const contentBudget = MAX_TOOL_RESULT_BYTES - estimateBytes(baseResult()) + 2;
  const markerBlock: ProjectedToolContent = { type: "text", text: ITEM_OMISSION_MARKER };
  const markerBytes = estimateBytes(markerBlock);
  const retained = retainProjectedTail(
    result.content,
    contentBudget,
    markerBytes,
    0,
    projectToolBlock,
    omitted,
  );
  omitted = retained.omitted;
  const content = retained.blocks;
  if (omitted) content.unshift(markerBlock);
  return {
    content,
    ...(projectedDetails === undefined ? {} : { details: projectedDetails }),
    isError: result.isError ?? false,
    ...(result.terminate === undefined ? {} : { terminate: result.terminate }),
  };
}

function messageText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) => (block.type === "text" ? block.text : "[image]"))
    .join("\n");
}

function padAnsi(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function framed(theme: Theme, content: string, width: number, borderColor: "border" | "borderAccent" = "border"): string {
  const inner = Math.max(1, width - 2);
  return theme.fg(borderColor, "│") + padAnsi(content, inner) + theme.fg(borderColor, "│");
}

export class BtwOverlay implements Component, Focusable {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly callbacks: BtwOverlayCallbacks;
  private readonly editor: Editor;
  private readonly transcript: TranscriptItem[] = [];
  private transcriptEstimatedBytes = 0;
  private omittedTranscriptItems = 0;
  private readonly pendingTools = new Map<string, ToolExecutionComponent>();
  private readonly toolProjectionBytes = new WeakMap<Component, { args: number; result: number }>();
  private readonly childStatuses = new Map<string, string>();
  private _focused = false;
  private phase: OverlayPhase = "opening";
  private phaseMessage = "Forking the last complete parent context…";
  private parentRunning = false;
  private childRunning = false;
  private childSession: AgentSession | undefined;
  private forkLeafId: string | null = null;
  private scrollFromBottom = 0;
  private lastTranscriptViewport = 8;
  private lastMaxScroll = 0;
  private screenBounds: ScreenBounds | undefined;
  private disposed = false;

  constructor(tui: TUI, theme: Theme, callbacks: BtwOverlayCallbacks) {
    this.tui = tui;
    this.theme = theme;
    this.callbacks = callbacks;

    const editorTheme: EditorTheme = {
      borderColor: (text) => theme.fg(this._focused ? "borderAccent" : "borderMuted", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    };
    this.editor = new Editor(tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 5 });
    this.editor.onSubmit = (text) => this.submit(text);
    this.editor.disableSubmit = true;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value;
    this.requestRender();
  }

  setForkLeaf(id: string | null): void {
    this.forkLeafId = id;
    this.requestRender();
  }

  attachSession(session: AgentSession): void {
    this.childSession = session;
    this.phase = "ready";
    this.phaseMessage = "Independent context · shared workspace";
    this.editor.disableSubmit = false;
    this.requestRender();
  }

  setOpeningMessage(message: string): void {
    this.phase = "opening";
    this.phaseMessage = message;
    this.editor.disableSubmit = true;
    this.requestRender();
  }

  setClosing(message = "Closing child session…"): void {
    this.phase = "closing";
    this.phaseMessage = message;
    this.editor.disableSubmit = true;
    this.requestRender();
  }

  setParentRunning(running: boolean): void {
    this.parentRunning = running;
    this.requestRender();
  }

  setChildStatus(key: string, text: string | undefined): void {
    if (text) this.childStatuses.set(key, text);
    else this.childStatuses.delete(key);
    this.requestRender();
  }

  focusEditor(): void {
    this.scrollFromBottom = 0;
    this.requestRender();
  }

  getScreenBounds(): ScreenBounds | undefined {
    return this.screenBounds ? { ...this.screenBounds } : undefined;
  }

  /** Positive deltas scroll toward older transcript lines; negative deltas return toward the tail. */
  scrollBy(delta: number): void {
    if (!Number.isFinite(delta) || delta === 0) return;
    this.scrollFromBottom = Math.max(
      0,
      Math.min(this.lastMaxScroll, this.scrollFromBottom + Math.trunc(delta)),
    );
    this.requestRender();
  }

  addNotice(message: string, type: "info" | "warning" | "error" = "info"): void {
    const color = type === "error" ? "error" : type === "warning" ? "warning" : "muted";
    const projected = boundedText(message, MAX_TRANSCRIPT_ITEM_BYTES);
    const lines = projected.split("\n");
    this.appendTranscript({
      spacing: this.transcript.length > 0,
      estimatedBytes: estimateBytes(projected),
      component: {
        invalidate() {},
        render: (width) => lines.flatMap((line) => wrapTextWithAnsi(this.theme.fg(color, `› ${line}`), Math.max(1, width))),
      },
    });
    this.requestRender();
  }

  handleSessionEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start":
        this.childRunning = true;
        break;
      case "agent_settled":
        this.childRunning = false;
        break;
      case "message_start":
        if (event.message.role === "user") {
          const text = boundedText(messageText(event.message), MAX_TRANSCRIPT_ITEM_BYTES);
          if (text) {
            this.appendTranscript({
              spacing: this.transcript.length > 0,
              estimatedBytes: estimateBytes(text),
              component: new UserMessageComponent(text, getMarkdownTheme(), 0),
            });
          }
        } else if (event.message.role === "assistant") {
          const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "thinking", 0);
          const projected = projectAssistantMessage(event.message);
          component.updateContent(projected);
          this.appendTranscript({
            spacing: this.transcript.length > 0,
            estimatedBytes: estimateBytes(projected.content),
            component,
          });
        }
        break;
      case "message_update":
        if (event.message.role === "assistant") {
          const assistant = this.findStreamingAssistant();
          const projected = projectAssistantMessage(event.message);
          assistant?.updateContent(projected);
          if (assistant) this.updateTranscriptEstimate(assistant, estimateBytes(projected.content));
          this.projectToolCalls(event.message);
        }
        break;
      case "message_end":
        if (event.message.role === "assistant") {
          const assistant = this.findStreamingAssistant();
          const projected = projectAssistantMessage(event.message);
          assistant?.updateContent(projected);
          if (assistant) this.updateTranscriptEstimate(assistant, estimateBytes(projected.content));
          this.projectToolCalls(event.message);
          if (event.message.stopReason === "aborted" || event.message.stopReason === "error") {
            const errorMessage = event.message.stopReason === "aborted"
              ? "Child run aborted."
              : (event.message.errorMessage ?? "Child model request failed.");
            for (const component of this.pendingTools.values()) {
              component.updateResult({
                content: [{ type: "text", text: errorMessage }],
                isError: true,
              });
            }
            this.pendingTools.clear();
            this.addNotice(errorMessage, event.message.stopReason === "error" ? "error" : "warning");
          } else {
            for (const component of this.pendingTools.values()) component.setArgsComplete();
          }
        }
        break;
      case "tool_execution_start": {
        const component = this.ensureTool(event.toolName, event.toolCallId, event.args);
        component.markExecutionStarted();
        break;
      }
      case "tool_execution_update": {
        const component = this.pendingTools.get(event.toolCallId);
        const projected = projectToolResult({ ...event.partialResult, isError: false });
        component?.updateResult(projected, true);
        if (component) this.updateToolResultEstimate(component, estimateBytes(projected));
        break;
      }
      case "tool_execution_end": {
        const component = this.pendingTools.get(event.toolCallId);
        const projected = projectToolResult({ ...event.result, isError: event.isError });
        component?.updateResult(projected);
        if (component) this.updateToolResultEstimate(component, estimateBytes(projected));
        this.pendingTools.delete(event.toolCallId);
        break;
      }
      case "compaction_start":
        this.addNotice(`Compacting child context (${event.reason})…`, "info");
        break;
      case "compaction_end":
        if (event.aborted) this.addNotice("Child compaction aborted.", "warning");
        else if (event.errorMessage) this.addNotice(event.errorMessage, "error");
        else this.addNotice("Child context compacted.", "info");
        break;
      case "auto_retry_start":
        this.addNotice(`Retrying child request ${event.attempt}/${event.maxAttempts}…`, "warning");
        break;
      case "auto_retry_end":
        if (!event.success) this.addNotice(event.finalError ?? "Child retry failed.", "error");
        break;
      case "queue_update":
      case "agent_end":
      case "turn_start":
      case "turn_end":
      case "entry_appended":
      case "session_info_changed":
      case "thinking_level_changed":
        break;
      default: {
        const exhaustive: never = event;
        void exhaustive;
      }
    }
    this.requestRender();
  }

  private appendTranscript(item: TranscriptItem): void {
    this.transcript.push(item);
    this.transcriptEstimatedBytes += item.estimatedBytes;
    this.enforceTranscriptCaps();
  }

  private updateTranscriptEstimate(component: Component, estimatedBytes: number): void {
    const item = this.transcript.findLast((candidate) => candidate.component === component);
    if (!item) return;
    this.transcriptEstimatedBytes += estimatedBytes - item.estimatedBytes;
    item.estimatedBytes = estimatedBytes;
    this.enforceTranscriptCaps();
  }

  private updateToolEstimate(
    component: Component,
    update: Partial<{ args: number; result: number }>,
  ): void {
    const current = this.toolProjectionBytes.get(component) ?? { args: 0, result: 0 };
    const next = { ...current, ...update };
    this.toolProjectionBytes.set(component, next);
    this.updateTranscriptEstimate(component, next.args + next.result);
  }

  private updateToolResultEstimate(component: Component, resultBytes: number): void {
    this.updateToolEstimate(component, { result: resultBytes });
  }

  private enforceTranscriptCaps(): void {
    while (
      this.transcript.length > 1 &&
      (
        this.transcript.length > MAX_TRANSCRIPT_ITEMS ||
        this.transcriptEstimatedBytes > MAX_TRANSCRIPT_ESTIMATED_BYTES
      )
    ) {
      const omitted = this.transcript.shift();
      if (!omitted) break;
      this.transcriptEstimatedBytes -= omitted.estimatedBytes;
      this.omittedTranscriptItems += 1;
    }
  }

  private findStreamingAssistant(): AssistantMessageComponent | undefined {
    for (let index = this.transcript.length - 1; index >= 0; index -= 1) {
      const component = this.transcript[index]!.component;
      if (component instanceof AssistantMessageComponent) return component;
    }
    return undefined;
  }

  private projectToolCalls(message: AssistantMessage): void {
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const projectedArgs = projectToolArguments(block.arguments);
      const component = this.ensureTool(block.name, block.id, projectedArgs);
      component.updateArgs(projectedArgs);
      this.updateToolEstimate(component, { args: estimateBytes(projectedArgs) });
    }
  }

  private ensureTool(name: string, id: string, args: unknown): ToolExecutionComponent {
    const existing = this.pendingTools.get(id);
    if (existing) return existing;
    const projectedArgs = projectToolArguments(args);
    const component = new ToolExecutionComponent(
      name,
      id,
      projectedArgs,
      { showImages: false },
      this.childSession?.getToolDefinition(name),
      this.tui,
      this.childSession?.sessionManager.getCwd() ?? process.cwd(),
    );
    component.setExpanded(false);
    this.pendingTools.set(id, component);
    const argsBytes = estimateBytes(projectedArgs);
    this.toolProjectionBytes.set(component, { args: argsBytes, result: 0 });
    this.appendTranscript({
      spacing: false,
      estimatedBytes: argsBytes,
      component,
    });
    return component;
  }

  private submit(raw: string): void {
    const text = raw.trim();
    if (!text) return;
    const control = text.toLowerCase();
    this.editor.addToHistory(text);
    this.editor.setText("");

    if (control === "done" || control === "/done" || control === "/btw done") {
      this.callbacks.onClose();
      return;
    }
    if (control === "/main") {
      this.callbacks.onMain();
      return;
    }
    this.callbacks.onSubmit(text);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("up"))) {
      this.scrollBy(Math.max(1, this.lastTranscriptViewport - 2));
      return;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("down"))) {
      this.scrollBy(-Math.max(1, this.lastTranscriptViewport - 2));
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.childRunning) this.callbacks.onAbort();
      else this.callbacks.onMain();
      return;
    }
    this.editor.handleInput(data);
    this.requestRender();
  }

  render(width: number): string[] {
    const panelWidth = Math.max(1, width);
    const innerWidth = Math.max(1, panelWidth - 2);
    const contentWidth = Math.max(1, innerWidth - 2);
    const actualTerminalRows = Math.max(1, this.tui.terminal.rows);
    const margin = BTW_OVERLAY_OPTIONS.margin;
    const availableRows = Math.max(1, actualTerminalRows - margin.top - margin.bottom);
    const targetHeight = Math.max(1, Math.min(Math.floor(actualTerminalRows * 0.94), availableRows));
    const borderColor = this._focused ? "borderAccent" : "border";
    const border = (value: string) => this.theme.fg(borderColor, value);
    const dimBorder = (value: string) => this.theme.fg("borderMuted", value);

    const childDot = this.childRunning
      ? this.theme.fg("accent", "●")
      : this.theme.fg("success", "●");
    const parentDot = this.parentRunning
      ? this.theme.fg("warning", "●")
      : this.theme.fg("dim", "○");
    const focusLabel = this._focused ? this.theme.fg("accent", "FOCUSED") : this.theme.fg("dim", "VISIBLE");
    const fork = this.forkLeafId ? this.forkLeafId.slice(0, 8) : "root";
    const statusText = this.phase === "ready"
      ? `${childDot} child ${this.childRunning ? "running" : "ready"}   ${parentDot} parent ${this.parentRunning ? "running" : "idle"}`
      : this.theme.fg("warning", this.phaseMessage);

    // Editor already maintains a cursor-aware viewport. Keep it intact: tail
    // slicing can hide the current line and cursor when editing near the top of
    // a long multiline message.
    const renderedEditorLines = this.editor.render(contentWidth);
    const shortLayout = targetHeight < 18;
    const editorBudget = shortLayout ? Math.max(1, targetHeight - 4) : renderedEditorLines.length;
    const cursorLine = renderedEditorLines.findIndex((line) => line.includes(CURSOR_MARKER));
    const editorStart = cursorLine < 0
      ? Math.max(0, renderedEditorLines.length - editorBudget)
      : Math.max(0, Math.min(cursorLine, renderedEditorLines.length - editorBudget));
    const editorLines = renderedEditorLines.slice(editorStart, editorStart + editorBudget);
    const fixedLines = 9 + editorLines.length;
    const transcriptViewport = shortLayout ? 0 : Math.max(1, targetHeight - fixedLines);
    this.lastTranscriptViewport = transcriptViewport;

    const projectedReverse: string[] = [];
    let projectedBytes = 0;
    let renderOmitted = this.omittedTranscriptItems > 0;

    transcriptItems:
    for (let itemIndex = this.transcript.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = this.transcript[itemIndex]!;
      const rendered = item.component.render(contentWidth);
      for (let lineIndex = rendered.length - 1; lineIndex >= 0; lineIndex -= 1) {
        const line = truncateToWidth(rendered[lineIndex]!, contentWidth, "");
        const lineBytes = Buffer.byteLength(line);
        if (
          projectedReverse.length >= MAX_PROJECTED_LINES ||
          projectedBytes + lineBytes > MAX_PROJECTED_BYTES
        ) {
          renderOmitted = true;
          break transcriptItems;
        }
        projectedReverse.push(line);
        projectedBytes += lineBytes;
      }
      if (item.spacing && itemIndex > 0) {
        if (projectedReverse.length >= MAX_PROJECTED_LINES) {
          renderOmitted = true;
          break;
        }
        projectedReverse.push("");
      }
    }

    const allTranscriptLines = projectedReverse.reverse();
    if (renderOmitted) {
      allTranscriptLines.unshift(this.theme.fg("warning", TRANSCRIPT_OMISSION_MARKER));
    }
    if (allTranscriptLines.length === 0) {
      allTranscriptLines.push(this.theme.fg("muted", "Ask a side question or prototype with the requested child tools."));
      allTranscriptLines.push(this.theme.fg("dim", "Parent updates stay paused until check_parent_updates is called."));
    }

    this.lastMaxScroll = Math.max(0, allTranscriptLines.length - transcriptViewport);
    this.scrollFromBottom = Math.min(this.scrollFromBottom, this.lastMaxScroll);
    const start = Math.max(0, allTranscriptLines.length - transcriptViewport - this.scrollFromBottom);
    const visibleTranscript = allTranscriptLines.slice(start, start + transcriptViewport);
    while (visibleTranscript.length < transcriptViewport) visibleTranscript.unshift("");

    const scrollLabel = this.lastMaxScroll === 0
      ? ""
      : this.scrollFromBottom === 0
        ? "TAIL"
        : `${this.scrollFromBottom}↑`;
    const extensionStatus = [...this.childStatuses.values()].at(-1);
    const phaseLine = extensionStatus ? `${this.phaseMessage} · ${extensionStatus}` : this.phaseMessage;

    const lines: string[] = [];
    const title = ` BTW  /  FORK ${fork} `;
    const titleWidth = Math.min(innerWidth, visibleWidth(title));
    lines.push(border("╭─") + this.theme.fg("accent", this.theme.bold(truncateToWidth(title, titleWidth, ""))) + border("─".repeat(Math.max(0, innerWidth - titleWidth - 1)) + "╮"));
    if (!shortLayout) {
      lines.push(framed(this.theme, ` ${statusText}`, panelWidth, borderColor));
      lines.push(framed(this.theme, ` ${focusLabel} ${this.theme.fg("dim", `· ${phaseLine}`)}`, panelWidth, borderColor));
      lines.push(dimBorder("├") + dimBorder("─".repeat(innerWidth)) + dimBorder("┤"));
      for (const line of visibleTranscript) lines.push(framed(this.theme, ` ${line}`, panelWidth, borderColor));
      const transcriptRule = ` transcript ${scrollLabel}`;
      lines.push(dimBorder("├") + this.theme.fg("dim", truncateToWidth(transcriptRule, innerWidth, "").padEnd(innerWidth, "─")) + dimBorder("┤"));
      lines.push(framed(this.theme, ` ${this.theme.fg("muted", "MESSAGE")}`, panelWidth, borderColor));
    }
    for (const line of editorLines) lines.push(framed(this.theme, ` ${line}`, panelWidth, borderColor));
    if (shortLayout) {
      lines.push(framed(this.theme, ` ${this.theme.fg("dim", "Esc main · click focus · /done close")}`, panelWidth, borderColor));
    } else {
      lines.push(framed(this.theme, ` ${this.theme.fg("dim", "Wheel/PgUp/PgDn scroll · click in/out focus")}`, panelWidth, borderColor));
      lines.push(framed(this.theme, ` ${this.theme.fg("dim", "Esc abort/main · /main unfocus · /done close")}`, panelWidth, borderColor));
    }
    lines.push(border("╰") + border("─".repeat(innerWidth)) + border("╯"));

    const rendered = lines.map((line) => truncateToWidth(line, panelWidth, ""));
    const terminalColumns = Math.max(1, this.tui.terminal.columns);
    const overlayHeight = rendered.length;
    const left = Math.max(0, terminalColumns - margin.right - panelWidth);
    const top = Math.max(
      margin.top,
      margin.top + Math.floor((availableRows - overlayHeight) / 2),
    );
    this.screenBounds = {
      left: left + 1,
      top: top + 1,
      right: Math.min(terminalColumns, left + panelWidth),
      bottom: Math.min(actualTerminalRows, top + overlayHeight),
    };

    return rendered;
  }

  invalidate(): void {
    this.editor.invalidate();
    for (const item of this.transcript) item.component.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.screenBounds = undefined;
    this.pendingTools.clear();
    this.transcript.length = 0;
    this.transcriptEstimatedBytes = 0;
    this.callbacks.onDispose?.();
  }

  private requestRender(): void {
    if (!this.disposed) this.tui.requestRender();
  }
}
