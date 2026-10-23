import type { Client } from '@modelcontextprotocol/client';
import { Console, Effect, Option, Schedule, Schema } from 'effect';

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
const logRetryBoundary = (failure: McpProofCallFailed) =>
  failure.retryable ? Console.error(`${failure.message}; at most one same-key retry permitted`) : Effect.void;

/** Retry only an identified transport failure of a write carrying the same explicit idempotency key. */
export const proofToolCall = <A,>(name: string, args: ProofToolArguments, invoke: () => Promise<A>) => {
  const write = Schema.decodeUnknownOption(StableWrite)(args);
  const stable = (name === 'ontos_execute' || name === 'ontos_propose') && Option.isSome(write);
  const operation = Option.match(write, { onNone: () => name, onSome: ({ id }) => `${name}/${id}` });
  return Effect.tryPromise({
    catch: (cause) => {
      const transport = Schema.decodeUnknownOption(TransientFetchError)(cause);
      const code = Option.match(transport, { onNone: () => 'unclassified', onSome: (error) => error.cause.code });
      const detail = code === 'unclassified' ? 'request failed' : `transport ${code}`;
      return new McpProofCallFailed({
        message: `${operation}: ${detail} (remote outcome unknown)`,
        retryable: stable && Option.isSome(transport),
      });
    },
    try: invoke,
  }).pipe(
    Effect.tapError(logRetryBoundary),
    Effect.retry({ schedule: Schedule.spaced('250 millis'), times: 1, while: retryable }),
  );
};
