/**
 * HTML-safety helpers for the server-rendered views.
 *
 * Extracted from server.ts so the escaping rule is unit-testable on its own.
 * There is no template engine here — every page route reads an .html file and
 * substitutes a token — so these helpers are the entire defence.
 */

/**
 * Serialises a value for embedding inside a `<script>` element.
 *
 * `JSON.stringify` alone is NOT safe for this. It does not escape `<` or `>`,
 * so a value containing `</script>` closes the script element early and
 * everything after it is parsed as HTML — stored XSS. In this application that
 * is reachable with externally supplied data: patient names are parsed out of
 * inbound C-CDA documents, so whoever sends a referral controls them.
 *
 * Escaping `<`, `>` and `&` as unicode escapes keeps the value a valid JS
 * string literal — `JSON.parse` on the client returns the original characters
 * byte for byte — while making it impossible to break out of the element.
 *
 * `&` is escaped as well as the angle brackets. It is not strictly required to
 * close a script element, but it blocks HTML-entity tricks in the surrounding
 * markup and costs nothing.
 *
 * EVERY page route must use this rather than `JSON.stringify`. The two look
 * identical at the call site and only one of them is safe.
 *
 * Deliberately NOT for: `res.json()` (sets its own content type), SSE
 * `text/event-stream` frames (not parsed as HTML), or values written into a
 * database column.
 */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}
