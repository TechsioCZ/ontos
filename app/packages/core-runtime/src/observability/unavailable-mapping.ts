import { Effect, Schema } from 'effect';

/**
 * One greppable warning per governed-read failure that is mapped to a 503 `unavailable` problem.
 * Callers pass only the error class and a sanitized message they already hold as typed values.
 */
export const UNAVAILABLE_MAPPING_EVENT = 'governed_read.unavailable_mapped';

export const UnavailableMappingPointSchema = Schema.Literals([
  'module-state-check',
  'read-transaction-connection',
  'spicedb-permission-check',
]);
export type UnavailableMappingPoint = typeof UnavailableMappingPointSchema.Type;

const MAX_MESSAGE_LENGTH = 200;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/giu;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(?<key>password|passwd|pwd|secret|token|authorization|api[_-]?key)\b\s*[=:]\s*\S+/giu;

/** Strips connection URLs and secret assignments, then bounds the length. */
export const sanitizeErrorMessage = (message: string): string =>
  message
    .replaceAll(URL_PATTERN, '<redacted-url>')
    .replaceAll(SECRET_ASSIGNMENT_PATTERN, '$<key>=<redacted>')
    .slice(0, MAX_MESSAGE_LENGTH);

/**
 * Emits the single structured warning for one mapped 503. `details` carries bounded, non-secret
 * values only: never connection strings, tokens, raw driver text or personal data.
 */
export const logUnavailableMapping = (
  point: UnavailableMappingPoint,
  phase: string,
  errorClass: string,
  details: Readonly<Record<string, number | string | boolean>> = {},
): Effect.Effect<void> =>
  Effect.logWarning(UNAVAILABLE_MAPPING_EVENT).pipe(Effect.annotateLogs({ ...details, errorClass, phase, point }));
