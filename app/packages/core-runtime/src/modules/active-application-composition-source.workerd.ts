import { env } from 'cloudflare:workers';
import { Duration, Effect, Schema } from 'effect';

import { ACTIVE_APPLICATION_COMPOSITION_EDGE_KEY } from './active-application-composition-edge.ts';

const KV_READ_TIMEOUT = Duration.seconds(5);
/** A KV text read resolves null for a missing key. */
const KvTextSchema = Schema.OptionFromNullOr(Schema.String);

class ActiveApplicationCompositionEdgeReadError extends Schema.TaggedError<ActiveApplicationCompositionEdgeReadError>()(
  'ActiveApplicationCompositionEdgeReadError',
  { cause: Schema.optionalKey(Schema.Defect()), reason: Schema.String },
) {}

/**
 * A placed Worker reads the snapshot the stage deploy wrote to its `ONTOS_ACTIVE_APPLICATION_COMPOSITION`
 * Workers KV binding. Every read goes to KV, so a new publication reaches the Worker within KV's
 * propagation time and no isolate keeps an expired observation; a missing binding or key fails closed.
 */
export const encodedActiveApplicationCompositionSnapshot = Effect.gen(function* readEdgeSnapshot() {
  const binding = env.ONTOS_ACTIVE_APPLICATION_COMPOSITION;
  if (binding === undefined) {
    return yield* new ActiveApplicationCompositionEdgeReadError({
      reason: 'The ONTOS_ACTIVE_APPLICATION_COMPOSITION Workers KV binding is required',
    });
  }
  const text = yield* Effect.tryPromise({
    catch: (cause) =>
      new ActiveApplicationCompositionEdgeReadError({ cause, reason: 'The Workers KV snapshot read failed' }),
    try: binding.get.bind(binding, ACTIVE_APPLICATION_COMPOSITION_EDGE_KEY, 'text'),
  }).pipe(
    Effect.timeoutOrElse({
      duration: KV_READ_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new ActiveApplicationCompositionEdgeReadError({ reason: 'The Workers KV snapshot read timed out' }),
        ),
    }),
  );
  const snapshot = yield* Schema.decodeEffect(KvTextSchema)(text).pipe(
    Effect.mapError(
      (cause) =>
        new ActiveApplicationCompositionEdgeReadError({ cause, reason: 'The Workers KV snapshot is not text' }),
    ),
  );
  return yield* Effect.fromOption(
    snapshot,
    () =>
      new ActiveApplicationCompositionEdgeReadError({
        reason: 'The ONTOS_ACTIVE_APPLICATION_COMPOSITION Workers KV binding holds no snapshot',
      }),
  );
});
