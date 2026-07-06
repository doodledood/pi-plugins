// keeper.ts — Anthropic 4th-cache-breakpoint keeper.
//
// pi places exactly three cache_control breakpoints on Anthropic requests:
// last tool, system block, and the last user message. Anthropic's cache
// lookup walks at most 20 content-block positions backward from each
// breakpoint looking for a prefix an earlier request wrote. When more than
// 20 blocks land between two requests (subagent notification bursts,
// parallel tool turns), the lookup misses the previous write and the whole
// message history re-bills as a cache write (~$6 per hit at 500k context).
//
// Anthropic allows 4 breakpoints. This module stamps the spare one onto the
// block where the previous request's tail marker sat, guaranteeing the
// lookback finds the previous write no matter how many blocks were appended.
// Breakpoints are free — the stamp costs nothing when it isn't needed.
//
// Pure logic, no Pi runtime types: unit-testable with payload fixtures.

/**
 * Stamp the spare marker when the new tail marker sits more than this many
 * content blocks past the previous request's tail marker. Anthropic's
 * lookback window is 20 positions; 15 leaves margin for counting drift
 * between our view and the provider's (string-content normalization etc.).
 */
export const KEEPER_BLOCK_GAP_THRESHOLD = 15;

/** Anthropic's hard limit on cache_control breakpoints per request. */
export const MAX_CACHE_BREAKPOINTS = 4;

/** Block types Anthropic accepts a cache_control marker on. */
const CACHEABLE_BLOCK_TYPES = new Set(["text", "image", "tool_result", "tool_use", "document"]);

export interface KeeperState {
  /** Flattened content-block index of the previous request's tail marker. */
  lastTailMarkerIndex?: number;
  /** Number of message content blocks in the previous request (shrink detection). */
  lastBlockCount?: number;
}

export interface KeeperResult {
  /** Replacement payload when a marker was stamped; undefined = leave payload untouched. */
  payload?: unknown;
  /** Why the keeper did or didn't act (for tests/diagnostics). */
  action: "stamped" | "first_request" | "under_threshold" | "no_spare_slot" | "not_anthropic" | "history_shrunk" | "no_tail_marker" | "no_cacheable_block";
}

interface FlatBlock {
  messageIndex: number;
  /** Index within the message's content array; -1 when content is a plain string. */
  blockIndex: number;
  type: string;
  hasMarker: boolean;
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Flatten message content into provider-order blocks, noting existing markers. */
function flattenBlocks(messages: readonly unknown[]): FlatBlock[] {
  const blocks: FlatBlock[] = [];
  messages.forEach((message, messageIndex) => {
    if (!isDict(message)) return;
    const content = message.content;
    if (typeof content === "string") {
      // Providers treat string content as a single text block.
      blocks.push({ messageIndex, blockIndex: -1, type: "text", hasMarker: false });
      return;
    }
    if (!Array.isArray(content)) return;
    content.forEach((block, blockIndex) => {
      if (!isDict(block)) return;
      blocks.push({
        messageIndex,
        blockIndex,
        type: typeof block.type === "string" ? block.type : "unknown",
        hasMarker: isDict(block.cache_control),
      });
    });
  });
  return blocks;
}

/** Count cache_control markers outside messages (tools + system blocks). */
function countPrefixMarkers(payload: Dict): number {
  let count = 0;
  const tools = payload.tools;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (isDict(tool) && isDict(tool.cache_control)) count++;
    }
  }
  const system = payload.system;
  if (Array.isArray(system)) {
    for (const block of system) {
      if (isDict(block) && isDict(block.cache_control)) count++;
    }
  }
  return count;
}

/**
 * Inspect an outgoing provider payload and, when needed, return a deep-copied
 * replacement with the spare cache_control breakpoint stamped at the previous
 * request's tail-marker position. Mutates `state` to track this request.
 */
export function applyCacheKeeper(rawPayload: unknown, state: KeeperState): KeeperResult {
  if (!isDict(rawPayload) || !Array.isArray(rawPayload.messages)) {
    return { action: "not_anthropic" };
  }
  const payload = rawPayload as Dict;
  const blocks = flattenBlocks(payload.messages as unknown[]);
  const messageMarkers = blocks.filter((b) => b.hasMarker);
  const tailMarker = messageMarkers[messageMarkers.length - 1];

  // pi only stamps cache_control on Anthropic-family payloads. No message
  // marker means either a different provider or caching disabled — leave it.
  if (!tailMarker) {
    state.lastTailMarkerIndex = undefined;
    state.lastBlockCount = undefined;
    return { action: "no_tail_marker" };
  }

  const tailIndex = blocks.indexOf(tailMarker);
  const previousIndex = state.lastTailMarkerIndex;
  const previousCount = state.lastBlockCount;
  state.lastTailMarkerIndex = tailIndex;
  state.lastBlockCount = blocks.length;

  if (previousIndex === undefined || previousCount === undefined) {
    return { action: "first_request" };
  }
  // Branch switch / rewind: the conversation shrank, so the remembered
  // position no longer describes this request. Re-anchor and stand down.
  if (blocks.length < previousCount || tailIndex < previousIndex) {
    return { action: "history_shrunk" };
  }
  if (tailIndex - previousIndex <= KEEPER_BLOCK_GAP_THRESHOLD) {
    return { action: "under_threshold" };
  }

  const totalMarkers = countPrefixMarkers(payload) + messageMarkers.length;
  if (totalMarkers >= MAX_CACHE_BREAKPOINTS) {
    // e.g. OAuth mode: pi already uses two system-block markers. No spare slot.
    return { action: "no_spare_slot" };
  }

  // Walk backward from the previous tail-marker position to the nearest
  // cacheable, unmarked block. A cache entry exists at (or covering) this
  // position from the previous request, so a breakpoint here is a guaranteed hit.
  let target: FlatBlock | undefined;
  for (let i = previousIndex; i >= 0; i--) {
    const candidate = blocks[i];
    if (candidate && CACHEABLE_BLOCK_TYPES.has(candidate.type) && !candidate.hasMarker) {
      target = candidate;
      break;
    }
  }
  if (!target) {
    return { action: "no_cacheable_block" };
  }

  // Copy the ttl shape pi chose so mixed-TTL rules can't reject the request.
  const tailBlock = blockAt(payload.messages as unknown[], tailMarker);
  const cacheControl = isDict(tailBlock) && isDict(tailBlock.cache_control) ? { ...tailBlock.cache_control } : { type: "ephemeral" };

  const replacement = structuredClone(payload);
  const messages = replacement.messages as unknown[];
  const message = messages[target.messageIndex];
  if (!isDict(message)) return { action: "no_cacheable_block" };
  if (target.blockIndex === -1) {
    // Promote string content to block form (same normalization pi applies).
    message.content = [{ type: "text", text: message.content, cache_control: cacheControl }];
  } else {
    const content = message.content;
    if (!Array.isArray(content)) return { action: "no_cacheable_block" };
    const block = content[target.blockIndex];
    if (!isDict(block)) return { action: "no_cacheable_block" };
    block.cache_control = cacheControl;
  }
  return { payload: replacement, action: "stamped" };
}

function blockAt(messages: readonly unknown[], flat: FlatBlock): unknown {
  const message = messages[flat.messageIndex];
  if (!isDict(message)) return undefined;
  if (flat.blockIndex === -1) return undefined;
  const content = message.content;
  return Array.isArray(content) ? content[flat.blockIndex] : undefined;
}
