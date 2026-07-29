/**
 * Durable substrate schemas.
 *
 * Every record here is written by one process and read by another (reporter,
 * triage, drills, the seat), so these types are contracts, not conveniences.
 * Each has a hand-written parser: a reader must tolerate a partial, malformed,
 * or newer-versioned file without treating it as healthy empty state.
 */

export const SESSION_STATE_VERSION = 1 as const;
export const PACKET_VERSION = 1 as const;
export const RULING_VERSION = 1 as const;
export const AUDIT_VERSION = 1 as const;
export const DEFECT_VERSION = 1 as const;
export const DRILL_LOG_VERSION = 1 as const;

/** How a session came to exist, which decides whether HQ may act on it. */
export type SessionRole =
  /** A human is in the seat. Observed only: never triaged, never actuated. */
  | "attended"
  /** Spawned by HQ. Full lifecycle: stop detection, triage, continuation. */
  | "managed";

/** What a managed session is for. */
export type SessionKind = "worker" | "triage" | "drill" | "continuation";

/** Fleet-facing lifecycle state. */
export type FleetState = "running" | "idle" | "drilling" | "done";

/** Why a session settled, as far as the reporter could tell. */
export type StopState =
  | "working"
  | "stopped-with-question"
  | "idle-done"
  | "aborted";

export interface SessionState {
  version: typeof SESSION_STATE_VERSION;
  sessionId: string;
  sessionFile: string | null;
  /** Owning process. Liveness is a PID probe; see io.isPidAlive. */
  pid: number;
  /** Distinguishes two runtimes that observed the same session id. */
  runtimeId: string;
  role: SessionRole;
  kind: SessionKind;
  /** Absolute cwd of the session, used to group the queue by project. */
  project: string;
  /** Short generated label, or null until one is generated. */
  title: string | null;
  state: FleetState;
  stopState: StopState;
  /** Last assistant text, normalized and truncated. Never a transcript. */
  preview: string;
  startedAt: string;
  /** Advances on every publish; staleness is measured from this. */
  lastEventAt: string;
  /**
   * Packets currently being drilled about this session. Drills own this field and
   * nothing else on the row: the board derives "drilling" from it, so a drill
   * never writes the lifecycle state and never has to restore one.
   */
  drillingPacketIds: string[];
  /** For drill/continuation sessions: the session they were derived from. */
  originSessionId: string | null;
  /** The packet a continuation is carrying, when it is carrying one. */
  packetId: string | null;
}

export type BlastRadius = "low" | "medium" | "high";
export type Reversibility = "reversible" | "one-way";
/**
 * `held` is the parking state for a packet that does not meet the bar: it is
 * in the queue and visible to the machinery, but it is never presented to the
 * user until drilling or completion clears its violations.
 */
export type PacketStatus = "pending" | "held" | "drilling" | "ruled" | "withdrawn";

export interface PacketOption {
  id: string;
  label: string;
  /** What this option costs or risks. The bar requires options be priced. */
  price: string;
  /**
   * True for an option that declines to decide — "hold and tell me more first".
   * Choosing it is not the user overruling doctrine, so it is not graded against
   * the shadow ruling and cannot manufacture a contradiction.
   */
  defers?: boolean;
}

export interface PacketAnnotation {
  at: string;
  question: string;
  answer: string;
  /** Verbatim quotes from the source, the anti-hearsay valve on drills. */
  quotes: Array<{ text: string; attribution: string }>;
  tier: 1 | 2;
}

/**
 * Some packets exist to change HQ itself: a rule to ratify, a rule to amend, or
 * a domain proposed for graduation. The payload rides on the packet so applying
 * a ratification needs nothing but the ruling and the packet.
 */
export interface PacketProposal {
  kind: "new-rule" | "amendment" | "graduation";
  scope: "global" | "project";
  section: string;
  /** The rule as proposed; for a graduation proposal, the rationale. */
  ruleText: string;
  /** For an amendment: the rule being replaced, folded to one line. */
  replaces: string | null;
  /** For a graduation proposal: the domain concerned. */
  domain: string | null;
}

/** A ruling the machinery would have made, recorded before the user rules. */
export interface ShadowRuling {
  optionId: string | null;
  text: string;
  rationale: string;
  doctrineCitations: string[];
}

export interface Packet {
  version: typeof PACKET_VERSION;
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Bumped on every mutation; a ruling names the generation it answered. */
  generation: number;
  sourceSessionId: string;
  sourceSessionFile: string | null;
  project: string;
  /** Coarse decision area, the unit graduation is granted over. */
  domain: string;
  title: string;
  // ---- the packet bar ----
  question: string;
  options: PacketOption[];
  /** Must name one of options[].id. */
  recommendationId: string;
  /** What evidence would change the recommendation. */
  flipCondition: string;
  blastRadius: BlastRadius;
  reversibility: Reversibility;
  // ---- routing and history ----
  status: PacketStatus;
  /** Packet ids that must be ruled before this one; never batched together. */
  dependsOn: string[];
  doctrineCitations: string[];
  shadowRuling: ShadowRuling | null;
  annotations: PacketAnnotation[];
  /** Cheap enough to batch with its neighbours. */
  trivial: boolean;
  /** Set when the packet's subject is HQ's own doctrine or authority. */
  proposal: PacketProposal | null;
}

export type RulingForm = "accept" | "alternative" | "custom" | "defer";

/** Where a ruling was carried. */
export interface RulingRouting {
  action: "resume" | "steer" | "drill" | "none";
  sessionFile: string | null;
  spawnedSessionId: string | null;
  note: string;
}

/** How the ruling sat against doctrine — the doctrine death-loop's input. */
export type CoverageBucket = "covered-agreed" | "contradicts" | "uncovered";

export interface Ruling {
  version: typeof RULING_VERSION;
  id: string;
  at: string;
  packetId: string;
  packetGeneration: number;
  domain: string;
  project: string;
  form: RulingForm;
  optionId: string | null;
  text: string;
  /** Set when form === "defer": the question to drill. */
  question: string | null;
  coverage: CoverageBucket;
  /** Whether the shadow ruling matched, or null when there was none. */
  shadowAgreed: boolean | null;
  routing: RulingRouting;
}

/** The four things a stop can turn into. Closed set, so a typo cannot silently
 * disable a limit that counts outcomes (the respawn ceiling reads this). */
export type StopOutcome = "packet" | "continue" | "close" | "respawn";

/** A stop answered from doctrine without the user, kept inspectable. */
export interface AuditRecord {
  version: typeof AUDIT_VERSION;
  at: string;
  sourceSessionId: string;
  domain: string;
  project: string;
  ruleCitation: string;
  action: string;
  summary: string;
  sampledForReview: boolean;
}

/** Recorded when the user had to open a session to decide — the core bet's telemetry. */
export interface DefectRecord {
  version: typeof DEFECT_VERSION;
  at: string;
  packetId: string;
  missing: string;
  /** The ruling the user gave once they had looked. */
  ruling: string;
}

/** One line per drill step, so which tier answered is auditable. */
export interface DrillLogEntry {
  version: typeof DRILL_LOG_VERSION;
  at: string;
  packetId: string;
  question: string;
  tier: 1 | 2;
  /** "read" never opens a copy; "fork" resumes one. */
  action: "read" | "fork" | "answered" | "gave-up";
  runId: string | null;
}

/** Per-domain shadow-agreement tally. Never grants authority by itself. */
export interface DomainStats {
  domain: string;
  agreements: number;
  disagreements: number;
  consecutiveAgreements: number;
  firstConsecutiveAt: string | null;
  lastRulingAt: string | null;
  overrides: number;
  /**
   * Stops this domain answered from doctrine without asking. This is the record
   * that lengthens once a domain is graduated — rulings stop arriving, so audit
   * decay has to key off work done rather than agreements recorded.
   */
  autoAnswered: number;
  /** True only after an explicit user command. */
  graduated: boolean;
  graduatedAt: string | null;
  /** Set when a graduation proposal has already been queued. */
  proposedAt: string | null;
}

export interface GraduationState {
  version: 1;
  domains: Record<string, DomainStats>;
}

export function emptyDomainStats(domain: string): DomainStats {
  return {
    domain,
    agreements: 0,
    disagreements: 0,
    consecutiveAgreements: 0,
    firstConsecutiveAt: null,
    lastRulingAt: null,
    overrides: 0,
    autoAnswered: 0,
    graduated: false,
    graduatedAt: null,
    proposedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Parsers. Readers use these; a failed parse is absence-with-a-report, never
// silently-healthy empty state.
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function strOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Absent reads as an empty list; present-but-wrong reads as untrustworthy. */
function optionalStrArray(value: unknown): string[] | undefined {
  return value === undefined || value === null ? [] : strArray(value);
}

function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    out.push(entry);
  }
  return out;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const text = str(value);
  return text !== undefined && (allowed as readonly string[]).includes(text)
    ? (text as T)
    : undefined;
}

export const ROLES = ["attended", "managed"] as const;
export const KINDS = ["worker", "triage", "drill", "continuation"] as const;
const FLEET_STATES = ["running", "idle", "drilling", "done"] as const;
export const STOP_STATES = [
  "working",
  "stopped-with-question",
  "idle-done",
  "aborted",
] as const;
export const STOP_OUTCOMES = ["packet", "continue", "close", "respawn"] as const;
const BLASTS = ["low", "medium", "high"] as const;
const REVERSIBILITIES = ["reversible", "one-way"] as const;
const PACKET_STATUSES = ["pending", "held", "drilling", "ruled", "withdrawn"] as const;
const RULING_FORMS = ["accept", "alternative", "custom", "defer"] as const;
const COVERAGES = ["covered-agreed", "contradicts", "uncovered"] as const;
const ROUTING_ACTIONS = ["resume", "steer", "drill", "none"] as const;

export function parseSessionState(value: unknown): SessionState | undefined {
  if (!isRecord(value)) return undefined;
  if (num(value.version) !== SESSION_STATE_VERSION) return undefined;

  const sessionId = str(value.sessionId);
  const pid = num(value.pid);
  const runtimeId = str(value.runtimeId);
  const role = oneOf(value.role, ROLES);
  const kind = oneOf(value.kind, KINDS);
  const project = str(value.project);
  const state = oneOf(value.state, FLEET_STATES);
  const stopState = oneOf(value.stopState, STOP_STATES);
  const startedAt = str(value.startedAt);
  const lastEventAt = str(value.lastEventAt);
  const sessionFile = strOrNull(value.sessionFile);
  const title = strOrNull(value.title);
  const drillingPacketIds = strArray(value.drillingPacketIds) ?? [];
  const originSessionId = strOrNull(value.originSessionId);
  const packetId = strOrNull(value.packetId);

  if (
    sessionId === undefined || pid === undefined || runtimeId === undefined ||
    role === undefined || kind === undefined || project === undefined ||
    state === undefined || stopState === undefined || startedAt === undefined ||
    lastEventAt === undefined || sessionFile === undefined || title === undefined ||
    originSessionId === undefined || packetId === undefined
  ) {
    return undefined;
  }

  return {
    version: SESSION_STATE_VERSION,
    sessionId,
    sessionFile,
    pid,
    runtimeId,
    role,
    kind,
    project,
    title,
    state,
    stopState,
    preview: str(value.preview) ?? "",
    startedAt,
    lastEventAt,
    drillingPacketIds,
    originSessionId,
    packetId,
  };
}

function parseOptions(value: unknown): PacketOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: PacketOption[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const id = str(entry.id);
    const label = str(entry.label);
    const price = str(entry.price);
    if (id === undefined || label === undefined || price === undefined) return undefined;
    out.push({ id, label, price, ...(bool(entry.defers) ? { defers: true } : {}) });
  }
  return out;
}

function parseAnnotations(value: unknown): PacketAnnotation[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const out: PacketAnnotation[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const at = str(entry.at);
    const question = str(entry.question);
    const answer = str(entry.answer);
    const tier = num(entry.tier);
    if (at === undefined || question === undefined || answer === undefined) return undefined;
    if (tier !== 1 && tier !== 2) return undefined;
    const quotes: Array<{ text: string; attribution: string }> = [];
    if (!Array.isArray(entry.quotes)) return undefined;
    for (const quote of entry.quotes) {
      if (!isRecord(quote)) return undefined;
      const text = str(quote.text);
      const attribution = str(quote.attribution);
      if (text === undefined || attribution === undefined) return undefined;
      quotes.push({ text, attribution });
    }
    out.push({ at, question, answer, quotes, tier });
  }
  return out;
}

function parseShadow(value: unknown): ShadowRuling | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return undefined;
  const text = str(value.text);
  const rationale = str(value.rationale);
  const citations = strArray(value.doctrineCitations) ?? [];
  const optionId = strOrNull(value.optionId);
  if (text === undefined || rationale === undefined || optionId === undefined) return undefined;
  return { optionId, text, rationale, doctrineCitations: citations };
}

export function parsePacket(value: unknown): Packet | undefined {
  if (!isRecord(value)) return undefined;
  if (num(value.version) !== PACKET_VERSION) return undefined;

  const id = str(value.id);
  const createdAt = str(value.createdAt);
  const updatedAt = str(value.updatedAt);
  const generation = num(value.generation);
  const sourceSessionId = str(value.sourceSessionId);
  const sourceSessionFile = strOrNull(value.sourceSessionFile);
  const project = str(value.project);
  const domain = str(value.domain);
  const title = str(value.title);
  const question = str(value.question);
  const options = parseOptions(value.options);
  const recommendationId = str(value.recommendationId);
  const flipCondition = str(value.flipCondition);
  const blastRadius = oneOf(value.blastRadius, BLASTS);
  const reversibility = oneOf(value.reversibility, REVERSIBILITIES);
  const status = oneOf(value.status, PACKET_STATUSES);
  const dependsOn = optionalStrArray(value.dependsOn);
  const doctrineCitations = optionalStrArray(value.doctrineCitations);
  const shadowRuling = parseShadow(value.shadowRuling);
  const annotations = parseAnnotations(value.annotations);
  const proposal = parseProposal(value.proposal);

  if (
    id === undefined || createdAt === undefined || updatedAt === undefined ||
    generation === undefined || sourceSessionId === undefined ||
    sourceSessionFile === undefined || project === undefined || domain === undefined ||
    title === undefined || question === undefined || options === undefined ||
    dependsOn === undefined || doctrineCitations === undefined || proposal === undefined ||
    recommendationId === undefined || flipCondition === undefined ||
    blastRadius === undefined || reversibility === undefined || status === undefined ||
    shadowRuling === undefined || annotations === undefined
  ) {
    return undefined;
  }

  return {
    version: PACKET_VERSION,
    id,
    createdAt,
    updatedAt,
    generation,
    sourceSessionId,
    sourceSessionFile,
    project,
    domain,
    title,
    question,
    options,
    recommendationId,
    flipCondition,
    blastRadius,
    reversibility,
    status,
    dependsOn,
    doctrineCitations,
    shadowRuling,
    annotations,
    trivial: bool(value.trivial) ?? false,
    proposal,
  };
}

/** `undefined` means the record cannot be trusted; `null` means there is no proposal. */
function parseProposal(value: unknown): PacketProposal | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return undefined;
  const kind = oneOf(value.kind, ["new-rule", "amendment", "graduation"] as const);
  const scope = oneOf(value.scope, ["global", "project"] as const);
  const section = str(value.section);
  const ruleText = str(value.ruleText);
  if (kind === undefined || scope === undefined || section === undefined || ruleText === undefined) {
    return undefined;
  }
  return {
    kind,
    scope,
    section,
    ruleText,
    replaces: strOrNull(value.replaces) ?? null,
    domain: strOrNull(value.domain) ?? null,
  };
}

export function parseRuling(value: unknown): Ruling | undefined {
  if (!isRecord(value)) return undefined;
  if (num(value.version) !== RULING_VERSION) return undefined;

  const id = str(value.id);
  const at = str(value.at);
  const packetId = str(value.packetId);
  const packetGeneration = num(value.packetGeneration);
  const domain = str(value.domain);
  const project = str(value.project);
  const form = oneOf(value.form, RULING_FORMS);
  const optionId = strOrNull(value.optionId);
  const text = str(value.text);
  const question = strOrNull(value.question);
  const coverage = oneOf(value.coverage, COVERAGES);
  const routingValue = value.routing;

  if (
    id === undefined || at === undefined || packetId === undefined ||
    packetGeneration === undefined || domain === undefined || project === undefined ||
    form === undefined || optionId === undefined || text === undefined ||
    question === undefined || coverage === undefined || !isRecord(routingValue)
  ) {
    return undefined;
  }

  const action = oneOf(routingValue.action, ROUTING_ACTIONS);
  const sessionFile = strOrNull(routingValue.sessionFile);
  const spawnedSessionId = strOrNull(routingValue.spawnedSessionId);
  if (action === undefined || sessionFile === undefined || spawnedSessionId === undefined) {
    return undefined;
  }

  const shadowAgreedRaw = value.shadowAgreed;
  const shadowAgreed = shadowAgreedRaw === null
    ? null
    : bool(shadowAgreedRaw);
  if (shadowAgreed === undefined) return undefined;

  return {
    version: RULING_VERSION,
    id,
    at,
    packetId,
    packetGeneration,
    domain,
    project,
    form,
    optionId,
    text,
    question,
    coverage,
    shadowAgreed,
    routing: {
      action,
      sessionFile,
      spawnedSessionId,
      note: str(routingValue.note) ?? "",
    },
  };
}

/**
 * The append-only logs get the same treatment as the rest of the substrate: a
 * record a reader cannot trust is absence-with-a-report, not a field that reads
 * as a string and is actually undefined three frames later.
 */
export function parseAuditRecord(value: unknown): AuditRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (num(value.version) !== AUDIT_VERSION) return undefined;
  const at = str(value.at);
  const sourceSessionId = str(value.sourceSessionId);
  const domain = str(value.domain);
  const project = str(value.project);
  const ruleCitation = str(value.ruleCitation);
  const action = str(value.action);
  const summary = str(value.summary);
  if (
    at === undefined || sourceSessionId === undefined || domain === undefined ||
    project === undefined || ruleCitation === undefined || action === undefined ||
    summary === undefined
  ) {
    return undefined;
  }
  return {
    version: AUDIT_VERSION,
    at,
    sourceSessionId,
    domain,
    project,
    ruleCitation,
    action,
    summary,
    sampledForReview: bool(value.sampledForReview) ?? false,
  };
}

export function parseDefectRecord(value: unknown): DefectRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (num(value.version) !== DEFECT_VERSION) return undefined;
  const at = str(value.at);
  const packetId = str(value.packetId);
  const missing = str(value.missing);
  if (at === undefined || packetId === undefined || missing === undefined) return undefined;
  return {
    version: DEFECT_VERSION,
    at,
    packetId,
    missing,
    ruling: str(value.ruling) ?? "",
  };
}

export function parseDrillLogEntry(value: unknown): DrillLogEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (num(value.version) !== DRILL_LOG_VERSION) return undefined;
  const at = str(value.at);
  const packetId = str(value.packetId);
  const question = str(value.question);
  const action = oneOf(value.action, ["read", "fork", "answered", "gave-up"] as const);
  const tier = num(value.tier);
  const runId = strOrNull(value.runId);
  if (
    at === undefined || packetId === undefined || question === undefined ||
    action === undefined || (tier !== 1 && tier !== 2) || runId === undefined
  ) {
    return undefined;
  }
  return { version: DRILL_LOG_VERSION, at, packetId, question, tier, action, runId };
}

export function parseGraduationState(value: unknown): GraduationState | undefined {
  if (!isRecord(value)) return undefined;
  if (num(value.version) !== 1) return undefined;
  if (!isRecord(value.domains)) return undefined;

  const domains: Record<string, DomainStats> = {};
  for (const [key, raw] of Object.entries(value.domains)) {
    if (!isRecord(raw)) return undefined;
    const base = emptyDomainStats(key);
    domains[key] = {
      ...base,
      agreements: num(raw.agreements) ?? 0,
      disagreements: num(raw.disagreements) ?? 0,
      consecutiveAgreements: num(raw.consecutiveAgreements) ?? 0,
      firstConsecutiveAt: strOrNull(raw.firstConsecutiveAt) ?? null,
      lastRulingAt: strOrNull(raw.lastRulingAt) ?? null,
      overrides: num(raw.overrides) ?? 0,
      autoAnswered: num(raw.autoAnswered) ?? 0,
      graduated: bool(raw.graduated) ?? false,
      graduatedAt: strOrNull(raw.graduatedAt) ?? null,
      proposedAt: strOrNull(raw.proposedAt) ?? null,
    };
  }
  return { version: 1, domains };
}

/**
 * The packet bar, enforced structurally.
 *
 * A packet that fails this is never presented: it is drilled, completed, or
 * held. Placeholder-shaped values fail too — an empty field and the word
 * "TBD" cost the reader the same dive.
 */
export interface BarViolation {
  field: string;
  reason: string;
}

const PLACEHOLDER = /^(tbd|todo|n\/?a|unknown|none|\?+|-+|\.+)$/i;

function substantive(value: string, minWords: number): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (PLACEHOLDER.test(trimmed)) return false;
  return trimmed.split(/\s+/).length >= minWords;
}

export function packetBarViolations(packet: Packet): BarViolation[] {
  const violations: BarViolation[] = [];

  if (!substantive(packet.question, 3)) {
    violations.push({ field: "question", reason: "not a substantive question" });
  }
  if (packet.options.length < 2) {
    violations.push({ field: "options", reason: "fewer than two options to choose between" });
  }
  packet.options.forEach((option, index) => {
    if (!substantive(option.label, 1)) {
      violations.push({ field: `options[${index}].label`, reason: "empty or placeholder label" });
    }
    if (!substantive(option.price, 3)) {
      violations.push({
        field: `options[${index}].price`,
        reason: "option is not priced (what it costs, risks, or gives up)",
      });
    }
  });
  const ids = packet.options.map((option) => option.id);
  if (new Set(ids).size !== ids.length) {
    // A ruling names the option it chose by id, and the id is looked up again when
    // the ruling is carried; two options sharing one id would send the user's
    // decision somewhere they did not choose.
    violations.push({ field: "options", reason: "two options share an id" });
  }
  if (!packet.options.some((option) => option.id === packet.recommendationId)) {
    violations.push({
      field: "recommendationId",
      reason: "recommendation does not name one of the options",
    });
  }
  if (!substantive(packet.flipCondition, 4)) {
    violations.push({
      field: "flipCondition",
      reason: "no stated evidence that would change the recommendation",
    });
  }
  if (!substantive(packet.title, 2)) {
    violations.push({ field: "title", reason: "no readable title" });
  }
  if (!substantive(packet.domain, 1)) {
    violations.push({ field: "domain", reason: "no decision domain" });
  }
  // A decision packet without a shadow ruling silently stalls the authority
  // ladder: there is nothing for the user's ruling to be graded against. HQ's own
  // doctrine and graduation packets are exempt — they are not the machinery
  // predicting a decision, they are the machinery asking about itself.
  if (!packet.proposal) {
    if (!packet.shadowRuling) {
      violations.push({
        field: "shadowRuling",
        reason: "no shadow ruling to grade the user's decision against",
      });
    } else if (
      !substantive(packet.shadowRuling.text, 1) ||
      !substantive(packet.shadowRuling.rationale, 3)
    ) {
      // An empty shadow ruling grades as nothing, so presence alone is not enough.
      violations.push({
        field: "shadowRuling",
        reason: "the shadow ruling has no ruling or no reasoning",
      });
    } else if (!packet.shadowRuling.optionId) {
      // A shadow ruling with no option grades as a disagreement with whatever the
      // user picks, so an omission would report "your ruling went against doctrine"
      // to someone who simply accepted the recommendation.
      violations.push({
        field: "shadowRuling",
        reason: "the shadow ruling names no option to be graded",
      });
    } else if (packet.shadowRuling.optionId !== packet.recommendationId) {
      // The recommendation and the shadow ruling are one decision in two roles:
      // the advice the user reads, and the same call recorded as a prediction to be
      // graded. Advising one option while predicting another makes the grade — and
      // so the authority ladder built on it — measure nothing.
      violations.push({
        field: "shadowRuling",
        reason: "the shadow ruling predicts a different option than it recommends",
      });
    }
  }
  return violations;
}

export function meetsPacketBar(packet: Packet): boolean {
  return packetBarViolations(packet).length === 0;
}
