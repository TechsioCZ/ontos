/**
 * Attaches a diagnostic to a portal-auth problem or error value without publishing it. The property
 * is non-enumerable, so it never rides along in an `application/problem+json` body or any other
 * `JSON.stringify` of the value: JSON serialization walks only enumerable own properties.
 *
 * Every portal-auth group attaches its causes through this one function. A value that must not be
 * mutated — a shared singleton problem — is spread by its caller before it is handed over.
 */
export const withCause = <Value extends object>(value: Value, cause: unknown): Value =>
  Object.defineProperty(value, 'cause', { configurable: true, value: cause });
