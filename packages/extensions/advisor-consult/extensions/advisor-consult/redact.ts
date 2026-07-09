const REDACTED = "[REDACTED]";
const SECRET_KEY_PATTERN =
  "api[_-]?key|apikey|secret|token|password|passwd|passphrase|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret";

/**
 * Scrub provider secrets from subprocess diagnostics before they are surfaced to
 * the parent or persisted. A failing bootstrap extension can echo provider
 * config (apiKey/headers/bearer tokens) to stderr, so both quote styles and the
 * common secret carriers are covered. Anchored to `authorization` headers and
 * known secret keys so ordinary prose is not mangled.
 */
export function redactSecrets(value: string): string {
  return value
    .replace(
      /\b((?:proxy-)?authorization\s*[:=]\s*)['"]?((?:bearer|basic|digest)\s+)?[^\r\n'"}]+/gi,
      (_match, prefix: string, scheme = "") => `${prefix}${scheme}${REDACTED}`,
    )
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`)
    .replace(
      new RegExp(`(['"]?(?:${SECRET_KEY_PATTERN})['"]?\\s*[:=]\\s*)(['"]?)([^\\s"',}]+)(['"]?)`, "gi"),
      (_match, prefix: string, openQuote: string, _secret: string, closeQuote: string) =>
        `${prefix}${openQuote}${REDACTED}${closeQuote}`,
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED);
}
