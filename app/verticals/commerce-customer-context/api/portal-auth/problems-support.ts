import { Option, Schema } from 'effect';

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

/**
 * The allow-listed fields of a failure an operator log may carry. Provider errors such as Better
 * Auth's `APIError` also hold response bodies, headers and cookies, which never reach the log.
 */
const FailureLogSummarySchema = Schema.Struct({
  _tag: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
  operation: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
});

export interface FailureLogSummary {
  readonly code?: string;
  readonly failure: string;
  readonly operation?: string;
  readonly reason?: string;
  readonly status?: number | string;
}

export const failureLogSummary = <Failure>(failure: Failure): FailureLogSummary =>
  Option.match(Schema.decodeUnknownOption(FailureLogSummarySchema)(failure), {
    onNone: () => ({ failure: 'unrecognized' }),
    onSome: ({ _tag, ...fields }) => ({ ...fields, failure: _tag ?? 'untagged' }),
  });
