import type { Client } from '@modelcontextprotocol/client';
import { Console, Effect, Option, Predicate, Schedule, Schema } from 'effect';
import type { Cause } from 'effect';

type ProofToolArguments = NonNullable<Parameters<Client['callTool']>[0]['arguments']>;

const TransientFetchError = Schema.Struct({
  cause: Schema.Struct({
    code: Schema.Literals(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']),
  }),
  message: Schema.Literal('fetch failed'),
  name: Schema.Literal('TypeError'),
});
const IdempotencyKeySchema = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand('IdempotencyKey'));
const StableWrite = Schema.Struct({ id: Schema.String, idempotencyKey: IdempotencyKeySchema });

export class McpProofCallFailed extends Schema.TaggedError<McpProofCallFailed>()('McpProofCallFailed', {
  message: Schema.String,
  retryable: Schema.Boolean,
}) {}

const retryable = (failure: McpProofCallFailed) => failure.retryable;

const EXCERPT = 300;
/** Never a token: a bearer value or a cookie that an error text might echo is masked before anything is recorded. */
const masked = (text: string) =>
  text
    .replaceAll(/Bearer\s+\S+/giu, 'Bearer ***')
    .replaceAll(/(?<header>cookie|set-cookie):\s*[^;\n]+/giu, '$<header>: ***');

const FailureLink = Schema.Struct({
  cause: Schema.optional(Schema.Unknown),
  code: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  data: Schema.optional(
    Schema.Struct({
      status: Schema.optional(Schema.Number),
      statusText: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String),
    }),
  ),
  message: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});

/**
 * What an unclassified failure was, for the step line and the artefact: each error of its cause chain (name, code,
 * message) and, when an HTTP answer existed, its status and the first bytes of its body, which names an edge proxy's
 * error page apart from the app's own answer. Never a request header, token or cookie.
 */
export const describeProofFailure = (cause: unknown): string => {
  const links: string[] = [];
  let current = cause;
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    const link = Schema.decodeUnknownOption(FailureLink)(current);
    if (Option.isNone(link)) {
      links.push(Predicate.isString(current) ? masked(current).slice(0, EXCERPT) : 'unrecognised failure');
      break;
    }
    const { code, data, message, name } = link.value;
    const parts = [name ?? 'Error'];
    if (code !== undefined) {
      parts.push(`code=${String(code)}`);
    }
    if (data?.status !== undefined) {
      parts.push(['HTTP', String(data.status), ...(data.statusText === undefined ? [] : [data.statusText])].join(' '));
    }
    const body = data?.text ?? message;
    if (body !== undefined && body !== '') {
      parts.push(`«${masked(body).slice(0, EXCERPT)}»`);
    }
    links.push(parts.join(' '));
    current = link.value.cause;
  }
  return links.join(' <- ');
};

/** A fetch failure that never got a response byte (reset, timeout, DNS), wherever it sits in the cause chain. */
const transientTransportCode = (cause: unknown) => {
  let current = cause;
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    const transport = Schema.decodeUnknownOption(TransientFetchError)(current);
    if (Option.isSome(transport)) {
      return Option.some(transport.value.cause.code);
    }
    current = Option.getOrUndefined(Schema.decodeUnknownOption(FailureLink)(current))?.cause;
  }
  return Option.none();
};
const logRetryBoundary = (failure: McpProofCallFailed) =>
  failure.retryable ? Console.error(`${failure.message}; at most one same-key retry permitted`) : Effect.void;

/** Retry only an identified transport failure of a write carrying the same explicit idempotency key. */
export const proofToolCall = <A, R>(
  name: string,
  args: ProofToolArguments,
  invoke: Effect.Effect<A, Cause.UnknownError, R>,
) => {
  const write = Schema.decodeUnknownOption(StableWrite)(args);
  const stable = (name === 'ontos_execute' || name === 'ontos_propose') && Option.isSome(write);
  const operation = Option.match(write, { onNone: () => name, onSome: ({ id }) => `${name}/${id}` });
  return invoke.pipe(
    Effect.mapError(({ cause }) => {
      const transport = transientTransportCode(cause);
      const detail = Option.match(transport, {
        onNone: () => `request failed: ${describeProofFailure(cause)}`,
        onSome: (code) => `transport ${code} before any response`,
      });
      return new McpProofCallFailed({
        message: `${operation}: ${detail} (remote outcome unknown)`,
        retryable: stable && Option.isSome(transport),
      });
    }),
    Effect.timeoutOrElse({
      duration: '30 seconds',
      orElse: () =>
        Effect.fail(
          new McpProofCallFailed({
            message: `${operation}: request deadline exceeded (remote outcome unknown)`,
            retryable: false,
          }),
        ),
    }),
    Effect.tapError(logRetryBoundary),
    Effect.retry({ schedule: Schedule.spaced('250 millis'), times: 1, while: retryable }),
  );
};
